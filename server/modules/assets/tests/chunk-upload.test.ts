import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

import { assetsRoutes } from '@/modules/assets/index.js';
import { storeAttachmentChunk } from '@/modules/assets/services/chunk-upload.service.js';

for (const megabytes of [22, 100]) {
  test(`uploads and assembles a ${megabytes}MB document through bounded HTTP chunks`, async () => {
    const app = express();
    app.use((req, _res, next) => { Object.assign(req, { user: { id: 1 } }); next(); });
    app.use('/assets', assetsRoutes);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address() as { port: number };
    const uploadId = randomUUID();
    const totalSize = megabytes * 1024 * 1024;
    const chunkSize = 8 * 1024 * 1024;
    const expected = createHash('sha256');
    let storedPath: string | undefined;
    const upload = async (index: number, bytes: Buffer) => {
      const body = new FormData();
      for (const [key, value] of Object.entries({ uploadId, index, totalSize, name: 'chunk-test.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })) body.append(key, String(value));
      body.append('chunk', new Blob([new Uint8Array(bytes)]), 'chunk');
      const response = await fetch(`http://127.0.0.1:${address.port}/assets/files/chunks`, { method: 'POST', body });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json() as Promise<{ pending?: boolean; attachments?: Array<{ path: string; size: number }> }>;
    };
    try {
      const count = Math.ceil(totalSize / chunkSize);
      for (let index = 0; index < count; index++) {
        const bytes = Buffer.alloc(Math.min(chunkSize, totalSize - index * chunkSize), index);
        expected.update(bytes);
        const result = await upload(index, bytes);
        if (index === 0) assert.deepEqual(await upload(index, bytes), { pending: true });
        if (index < count - 1) assert.equal(result.pending, true);
        else {
          storedPath = result.attachments![0].path;
          assert.equal(result.attachments![0].size, totalSize);
          assert.deepEqual(await upload(index, bytes), result, 'lost final responses replay the same file');
        }
      }
      assert.equal((await fs.stat(storedPath!)).size, totalSize);
      const actual = createHash('sha256');
      for await (const bytes of createReadStream(storedPath!)) actual.update(bytes);
      assert.equal(actual.digest('hex'), expected.digest('hex'));
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      if (storedPath) await fs.unlink(storedPath);
      await fs.rm(path.join(os.homedir(), '.cloudcli/assets/.uploads', `1-${uploadId}`), { recursive: true, force: true });
    }
  });
}

test('chunk geometry and path traversal are rejected before storing data', async () => {
  const input = { userId: 1, uploadId: randomUUID(), index: 0, totalSize: 1, name: 'test', mimeType: '', bytes: Buffer.from('x') };
  for (const invalid of [{ uploadId: '../../escape' }, { userId: 0 }, { totalSize: 101 * 1024 * 1024 }, { index: -1 }, { totalSize: 8 * 1024 * 1024 }]) {
    await assert.rejects(storeAttachmentChunk({ ...input, ...invalid }), /Invalid upload chunk/);
  }
});

test('upload IDs are scoped to the authenticated user and cannot change file metadata', async () => {
  const uploadId = randomUUID();
  const paths: string[] = [];
  const input = { userId: 1, uploadId, index: 0, totalSize: 1, name: 'test.txt', mimeType: 'text/plain', bytes: Buffer.from('x') };
  try {
    for (const userId of [1, 2]) {
      const result = await storeAttachmentChunk({ ...input, userId });
      assert.ok('attachments' in result);
      paths.push(result.attachments![0].path);
    }
    assert.notEqual(paths[0], paths[1]);
    await assert.rejects(storeAttachmentChunk({ ...input, name: 'changed.txt' }), /identity changed/);
  } finally {
    for (const file of paths) await fs.unlink(file);
    for (const userId of [1, 2]) await fs.rm(path.join(os.homedir(), '.cloudcli/assets/.uploads', `${userId}-${uploadId}`), { recursive: true, force: true });
  }
});
