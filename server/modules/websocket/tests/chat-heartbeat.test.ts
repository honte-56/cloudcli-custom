import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';

test('browser heartbeats are answered without invoking provider or database operations', () => {
  const frames: unknown[] = [];
  const socket = Object.assign(new EventEmitter(), {
    readyState: 1,
    send: (frame: string) => frames.push(JSON.parse(frame)),
  });
  handleChatConnection(socket as never, { user: { id: 1 } } as never, {} as never);
  try {
    socket.emit('message', JSON.stringify({ type: 'chat.ping' }));
    assert.deepEqual(frames, [{ kind: 'chat_pong' }]);
  } finally {
    socket.emit('close');
  }
});
