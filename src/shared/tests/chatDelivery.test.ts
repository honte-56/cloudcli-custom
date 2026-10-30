import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createChatDelivery } from '@/shared/chatDelivery';

beforeEach(() => { vi.useFakeTimers(); sessionStorage.clear(); });
afterEach(() => { vi.useRealTimers(); });

function fixture() {
  const socket = { readyState: 1, send: vi.fn(), close: vi.fn() };
  const delivery = createChatDelivery(() => socket, () => 'test-user');
  const message = { type: 'chat.send', sessionId: 's', content: 'hello' };
  const frame = () => JSON.parse(socket.send.mock.calls.at(-1)![0]);
  return { socket, delivery, message, frame };
}

test('offline sends fail explicitly without writing a frame', async () => {
  const f = fixture(); f.socket.readyState = 3;
  await expect(f.delivery.send(f.message)).rejects.toThrow('消息未发送');
  expect(f.socket.send).not.toHaveBeenCalled();
});

test('receipt is required; reconnect resends the same request id', async () => {
  const f = fixture(); let accepted = false;
  const waiting = f.delivery.send(f.message).then(() => { accepted = true; });
  const first = f.frame();
  await Promise.resolve(); expect(accepted).toBe(false);
  f.delivery.reconnect(); expect(f.frame()).toEqual(first);
  f.delivery.receive({ kind: 'chat_send_receipt', requestId: first.requestId, status: 'accepted' });
  await waiting; expect(accepted).toBe(true);
  expect(sessionStorage.length).toBe(0);
  f.delivery.dispose();
});

test('timeout and page reload retain the request id; confirmed next turn gets a new id', async () => {
  const f = fixture();
  const rejected = expect(f.delivery.send(f.message)).rejects.toThrow('尚未收到');
  const first = f.frame();
  await vi.advanceTimersByTimeAsync(25_000); await rejected;
  expect(f.socket.close).toHaveBeenCalledOnce();
  const replacement = createChatDelivery(() => f.socket, () => 'test-user');
  const unrelated = replacement.send({ ...f.message, content: 'another request' });
  replacement.receive({ kind: 'chat_send_receipt', requestId: f.frame().requestId, status: 'accepted' });
  await unrelated;
  const retry = replacement.send(f.message);
  expect(f.frame().requestId).toBe(first.requestId);
  replacement.receive({ kind: 'chat_send_receipt', requestId: first.requestId, status: 'accepted' });
  await retry;
  const next = replacement.send(f.message);
  expect(f.frame().requestId).not.toBe(first.requestId);
  replacement.receive({ kind: 'chat_send_receipt', requestId: f.frame().requestId, status: 'accepted' });
  await next;
});

test('rejection is visible and an unrelated receipt cannot confirm a message', async () => {
  const f = fixture(); const rejected = expect(f.delivery.send(f.message)).rejects.toThrow('busy');
  f.delivery.receive({ kind: 'chat_send_receipt', requestId: 'unrelated', status: 'accepted' });
  f.delivery.receive({ kind: 'chat_send_receipt', requestId: f.frame().requestId, status: 'rejected', error: 'busy' });
  await rejected; expect(sessionStorage.length).toBe(0);
});
