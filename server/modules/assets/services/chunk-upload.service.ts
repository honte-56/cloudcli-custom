import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { buildStoredAttachmentRecords, ensureImageAssetsDir } from '@/modules/assets/services/image-assets.service.js';

const CHUNK_SIZE = 8 * 1024 * 1024;
const MAX_FILE_SIZE = 100 * 1024 * 1024;
const locks = new Map<string, Promise<void>>();
let nextCleanupAt = 0;

async function cleanExpiredUploads(root: string) {
  if (Date.now() < nextCleanupAt) return;
  nextCleanupAt = Date.now() + 60 * 60 * 1000;
  for (const name of await fs.readdir(root)) {
    if (!/^\d+-[\da-f-]{36}$/i.test(name) || locks.has(name)) continue;
    const folder = path.join(root, name);
    const stat = await fs.stat(folder);
    if (Date.now() - stat.mtimeMs > 24 * 60 * 60 * 1000) await fs.rm(folder, { recursive: true, force: true });
  }
}

/** Used by assets routes to store bounded chunks and assemble a retriable, user-owned attachment. */
export async function storeAttachmentChunk(input: {
  userId: number; uploadId: string; index: number; totalSize: number;
  name: string; mimeType: string; bytes: Buffer;
}) {
  const { userId, uploadId, index, totalSize, name, mimeType, bytes } = input;
  const count = Math.ceil(totalSize / CHUNK_SIZE);
  if (!Number.isSafeInteger(userId) || userId <= 0
    || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(uploadId)
    || !Number.isSafeInteger(totalSize) || totalSize <= 0 || totalSize > MAX_FILE_SIZE
    || !Number.isSafeInteger(index) || index < 0 || index >= count
    || !name || name.length > 255 || mimeType.length > 255
    || bytes.length !== Math.min(CHUNK_SIZE, totalSize - index * CHUNK_SIZE)) {
    throw new Error('Invalid upload chunk (maximum file size: 100MB).');
  }
  const key = `${userId}-${uploadId}`;
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const lock = new Promise<void>(resolve => { release = resolve; });
  locks.set(key, lock);
  await previous;
  try {
    const assets = await ensureImageAssetsDir();
    const root = path.join(assets, '.uploads');
    const folder = path.join(root, key);
    await fs.mkdir(folder, { recursive: true });
    await cleanExpiredUploads(root);
    await fs.utimes(folder, new Date(), new Date());
    const metadataPath = path.join(folder, 'metadata.json');
    const identity = JSON.stringify({ name, mimeType, totalSize });
    let metadata: { identity: string; storedName: string };
    try {
      metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      metadata = { identity, storedName: `${Date.now()}-${randomUUID()}-${name.replace(/[^a-zA-Z0-9.-]/g, '_').slice(-120)}` };
      await fs.writeFile(metadataPath, JSON.stringify(metadata));
    }
    if (metadata.identity !== identity) throw new Error('Upload identity changed. Select the file again.');
    const destination = path.join(assets, metadata.storedName);
    const result = () => ({ attachments: buildStoredAttachmentRecords([{
      originalname: name, filename: metadata.storedName, size: totalSize, mimetype: mimeType,
    }]) });
    // A lost final response (or restart after the rename) must not duplicate a file.
    if (await fs.stat(destination).then(() => true, () => false)) return result();
    await fs.writeFile(path.join(folder, `${index}.chunk`), bytes);
    for (let part = 0; part < count; part++) {
      if (!await fs.stat(path.join(folder, `${part}.chunk`)).then(() => true, () => false)) {
        return { pending: true };
      }
    }
    const assembled = path.join(folder, 'assembled.partial');
    for (let part = 0; part < count; part++) {
      await pipeline(createReadStream(path.join(folder, `${part}.chunk`)), createWriteStream(assembled, { flags: part === 0 ? 'w' : 'a' }));
    }
    await fs.rename(assembled, destination);
    await Promise.all(Array.from({ length: count }, (_, part) => fs.unlink(path.join(folder, `${part}.chunk`))));
    return result();
  } finally {
    release();
    if (locks.get(key) === lock) locks.delete(key);
  }
}
