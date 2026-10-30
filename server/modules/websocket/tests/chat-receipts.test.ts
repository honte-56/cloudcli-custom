import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { WebSocket } from 'ws';
import { closeConnection } from '@/modules/database/index.js';
import { acknowledgeChatSend, withChatReceipt } from '@/modules/websocket/services/chat-receipts.service.js';

test('receipts survive reconnect, completion and database reopen without redispatching', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chat-receipts-'));
  const previous = process.env.DATABASE_PATH;
  closeConnection(); process.env.DATABASE_PATH = path.join(directory, 'test.db');
  const frames: Record<string, unknown>[] = [];
  const ws = { readyState: 1, send: (value: string) => frames.push(JSON.parse(value)) } as unknown as WebSocket;
  const data = { type: 'chat.send', sessionId: 's', requestId: 'request-1234567890', content: 'hello' };
  let runs = 0;
  try {
    await withChatReceipt(ws, 1, data, async () => { acknowledgeChatSend(data); runs++; });
    assert.equal(frames.at(-1)?.status, 'accepted');
    closeConnection();
    await withChatReceipt(ws, 1, { ...data }, async () => { runs++; });
    assert.equal(runs, 1); assert.equal(frames.at(-1)?.status, 'accepted');
    assert.equal(frames.at(-1)?.replayed, true);
    await withChatReceipt(ws, 1, { ...data, content: 'different' }, async () => { runs++; });
    assert.equal(frames.at(-1)?.status, 'rejected'); assert.equal(runs, 1);
    const invalid = { ...data, requestId: 'request-invalid-123' };
    await withChatReceipt(ws, 1, invalid, async () => {});
    assert.equal(frames.at(-1)?.status, 'rejected');
    const anotherUser = { ...data };
    await withChatReceipt(ws, 2, anotherUser, async () => { acknowledgeChatSend(anotherUser); runs++; });
    assert.equal(runs, 2);
    let release!: () => void;
    const blocked = { ...data, requestId: 'request-pending-123' };
    const first = withChatReceipt(ws, 1, blocked, async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      acknowledgeChatSend(blocked); runs++;
    });
    await withChatReceipt(ws, 1, { ...blocked }, async () => { runs++; });
    assert.equal(frames.at(-1)?.status, 'pending');
    release(); await first; assert.equal(runs, 3);
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
