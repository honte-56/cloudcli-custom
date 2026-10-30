import assert from 'node:assert/strict';

import { act, render } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

/**
 * Issue #582: when the chat socket dropped, nothing in the UI changed, so a
 * message typed during the outage was lost without the user noticing. The
 * provider now reports `connectionStatus`, which tells a lost connection
 * (`disconnected`) apart from the first handshake (`connecting`, which must not
 * flash a warning on every page load) and from the socket it swaps on purpose
 * when the auth token is refreshed (which must not read as lost either).
 */

type FakeAuth = { user: { id: number } | null; token: string | null; isLoading: boolean };

// Mutable so a test can hand the provider a refreshed token or sign the user
// out. `user` keeps one identity throughout; a fresh object would rebuild
// `connect` on every render.
const AUTH = vi.hoisted(() => {
  const user = { id: 1 };
  return { user, current: { user, token: 'token-1', isLoading: false } as FakeAuth };
});

vi.mock('@/modules/auth', () => ({
  useAuth: () => AUTH.current,
}));

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  sent: string[] = [];
  send(value: string) { this.sent.push(value); }

  // A real socket closed by the page still fires `close`; firing it here means
  // a swap that forgot to detach its handler would be caught.
  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  serverOpens() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  /** The network or the server ends the socket (or refuses the handshake). */
  serverDrops() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

const { WebSocketProvider, useWebSocket } = await import('@/shared/context/WebSocketContext');

/** Every status the provider rendered, in order, so a one-render flash is caught too. */
let seen: string[] = [];
let currentContext: ReturnType<typeof useWebSocket>;
let isConnected: boolean | null = null;

function RecordStatus() {
  const value = useWebSocket();
  seen.push(String(value.connectionStatus));
  useEffect(() => {
    currentContext = value;
    isConnected = value.isConnected;
  });
  return null;
}

const renderProvider = () => render(<WebSocketProvider><RecordStatus /></WebSocketProvider>);
const socket = (index: number) => FakeWebSocket.instances[index] as FakeWebSocket;
const lastStatus = () => seen[seen.length - 1];

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  seen = [];
  isConnected = null;
  AUTH.current = { user: AUTH.user, token: 'token-1', isLoading: false };
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('the first handshake reads as connecting, never as a lost connection', () => {
  renderProvider();
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.equal(lastStatus(), 'connecting');
  assert.equal(isConnected, false);

  act(() => socket(0).serverOpens());
  assert.equal(lastStatus(), 'connected');
  assert.equal(isConnected, true);
  assert.ok(!seen.includes('disconnected'), `statuses seen: ${seen.join(', ')}`);
});

test('a dropped socket reads as disconnected through every failed retry, until one opens', () => {
  renderProvider();
  act(() => socket(0).serverOpens());

  act(() => socket(0).serverDrops());
  assert.equal(lastStatus(), 'disconnected');
  assert.equal(isConnected, false);

  // The retry is still handshaking: the connection is not back yet.
  act(() => { vi.advanceTimersByTime(3000); });
  assert.equal(FakeWebSocket.instances.length, 2);
  assert.equal(lastStatus(), 'disconnected');

  // The server is still unreachable.
  act(() => socket(1).serverDrops());
  assert.equal(lastStatus(), 'disconnected');

  act(() => { vi.advanceTimersByTime(3000); });
  assert.equal(FakeWebSocket.instances.length, 3);
  act(() => socket(2).serverOpens());
  assert.equal(lastStatus(), 'connected');
  assert.equal(isConnected, true);
});

test('a first attempt that fails reads as disconnected', () => {
  renderProvider();
  act(() => socket(0).serverDrops());
  assert.equal(lastStatus(), 'disconnected');

  act(() => { vi.advanceTimersByTime(3000); });
  act(() => socket(1).serverOpens());
  assert.equal(lastStatus(), 'connected');
});

test('a token refresh swaps the socket without ever reading as a lost connection', () => {
  const view = renderProvider();
  act(() => socket(0).serverOpens());

  AUTH.current = { ...AUTH.current, token: 'token-2' };
  view.rerender(<WebSocketProvider><RecordStatus /></WebSocketProvider>);

  assert.equal(FakeWebSocket.instances.length, 2, 'the refreshed token opened a new socket');
  assert.equal(socket(0).readyState, FakeWebSocket.CLOSED, 'the old-token socket was closed');
  assert.match(socket(1).url, /token=token-2/);
  // The new socket is still handshaking: not live yet, but not lost either.
  assert.equal(lastStatus(), 'connecting');
  assert.equal(isConnected, false);

  // No reconnect was scheduled for the socket closed on purpose.
  act(() => { vi.advanceTimersByTime(3000); });
  assert.equal(FakeWebSocket.instances.length, 2);

  act(() => socket(1).serverOpens());
  assert.equal(lastStatus(), 'connected');
  assert.ok(!seen.includes('disconnected'), `statuses seen: ${seen.join(', ')}`);
});

test('signing out while the socket is down does not carry the drop into the next sign-in', () => {
  const view = renderProvider();
  act(() => socket(0).serverOpens());
  act(() => socket(0).serverDrops());
  assert.equal(lastStatus(), 'disconnected');

  // The session expires (or the user signs out) during the outage.
  AUTH.current = { user: null, token: null, isLoading: false };
  view.rerender(<WebSocketProvider><RecordStatus /></WebSocketProvider>);
  assert.equal(lastStatus(), 'connecting', 'no connection is lost while nobody is signed in');
  act(() => { vi.advanceTimersByTime(3000); });
  assert.equal(FakeWebSocket.instances.length, 1, 'no reconnect while signed out');

  // Signing in again starts a fresh handshake, which must not read as lost.
  seen = [];
  AUTH.current = { user: AUTH.user, token: 'token-2', isLoading: false };
  view.rerender(<WebSocketProvider><RecordStatus /></WebSocketProvider>);
  assert.equal(FakeWebSocket.instances.length, 2);
  assert.ok(!seen.includes('disconnected'), `statuses seen after sign-in: ${seen.join(', ')}`);
  assert.equal(lastStatus(), 'connecting');

  act(() => socket(1).serverOpens());
  assert.equal(lastStatus(), 'connected');
});

test('signing out while connected stops reporting a live connection', () => {
  const view = renderProvider();
  act(() => socket(0).serverOpens());
  assert.equal(isConnected, true);

  AUTH.current = { user: null, token: null, isLoading: false };
  view.rerender(<WebSocketProvider><RecordStatus /></WebSocketProvider>);
  assert.equal(socket(0).readyState, FakeWebSocket.CLOSED, 'the socket was closed on sign-out');
  assert.equal(lastStatus(), 'connecting');
  assert.equal(isConnected, false, 'isConnected no longer reports the closed socket as live');
});


test('a replayed admission reconciles history after the composer has resolved', async () => {
  const view = renderProvider();
  act(() => socket(0).serverOpens());
  const order: string[] = [];
  currentContext.subscribe(event => { if (event.kind === 'websocket_reconnected') order.push('reconcile'); });
  const waiting = Promise.resolve(currentContext.sendMessage({ type: 'chat.send', sessionId: 's', content: 'hello' }))
    .then(() => { order.push('composer'); });
  const frame = JSON.parse(socket(0).sent.at(-1)!);
  await act(async () => {
    socket(0).onmessage?.({ data: JSON.stringify({ kind: 'chat_send_receipt', requestId: frame.requestId, status: 'accepted', replayed: true }) });
    await waiting;
  });
  assert.deepEqual(order, ['composer']);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  assert.deepEqual(order, ['composer', 'reconcile']);
  view.unmount();
});

test('a stuck handshake times out and retries without waiting for close', () => {
  renderProvider();
  // Simulate the browser retaining a half-open connection even after close().
  socket(0).close = () => {};
  act(() => { vi.advanceTimersByTime(10_000); });
  assert.equal(lastStatus(), 'disconnected');
  act(() => { vi.advanceTimersByTime(3000); });
  assert.equal(FakeWebSocket.instances.length, 2);
  act(() => socket(1).serverOpens());
  assert.equal(isConnected, true);
});

test('a silent open connection is replaced and late callbacks cannot resurrect it', () => {
  renderProvider();
  act(() => socket(0).serverOpens());
  const oldOpen = socket(0).onopen!;
  const oldMessage = socket(0).onmessage!;
  const received: unknown[] = [];
  currentContext.subscribe(event => received.push(event));
  socket(0).close = () => {};
  act(() => { vi.advanceTimersByTime(15_000); });
  assert.deepEqual(JSON.parse(socket(0).sent.at(-1)!), { type: 'chat.ping' });
  act(() => { vi.advanceTimersByTime(13_000); });
  assert.equal(FakeWebSocket.instances.length, 2);
  act(() => { oldOpen(); oldMessage({ data: '{"kind":"stale"}' }); });
  assert.equal(lastStatus(), 'disconnected');
  assert.deepEqual(received, []);
  act(() => socket(1).serverOpens());
  assert.equal(isConnected, true);
});

test('heartbeat replies keep an idle connection alive without dispatching UI events', () => {
  renderProvider();
  act(() => socket(0).serverOpens());
  const listener = vi.fn();
  currentContext.subscribe(listener);
  for (let i = 0; i < 5; i++) {
    act(() => { vi.advanceTimersByTime(15_000); });
    act(() => socket(0).onmessage?.({ data: '{"kind":"chat_pong"}' }));
  }
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.equal(isConnected, true);
  assert.equal(listener.mock.calls.length, 0);
});

for (const event of ['online', 'focus', 'pageshow']) {
  test(`${event} recovers a disconnected socket immediately without duplicate reconnects`, () => {
    renderProvider();
    act(() => socket(0).serverDrops());
    act(() => window.dispatchEvent(new Event(event)));
    assert.equal(FakeWebSocket.instances.length, 2);
    act(() => window.dispatchEvent(new Event(event)));
    act(() => { vi.advanceTimersByTime(3000); });
    assert.equal(FakeWebSocket.instances.length, 2);
    act(() => socket(1).serverOpens());
    assert.equal(isConnected, true);
  });
}

test('returning after browser suspension replaces a stale socket', () => {
  renderProvider();
  act(() => socket(0).serverOpens());
  vi.setSystemTime(Date.now() + 60_000);
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  assert.equal(FakeWebSocket.instances.length, 2);
});

test('socket construction errors keep retrying and cleanup removes recovery listeners', () => {
  const realFake = FakeWebSocket;
  let attempts = 0;
  vi.stubGlobal('WebSocket', class extends FakeWebSocket {
    constructor(url: string) {
      if (++attempts === 1) throw new Error('Offline');
      super(url);
    }
  });
  const view = renderProvider();
  assert.equal(lastStatus(), 'disconnected');
  act(() => { vi.advanceTimersByTime(3000); });
  assert.equal(realFake.instances.length, 1);
  view.unmount();
  act(() => { window.dispatchEvent(new Event('online')); vi.advanceTimersByTime(60_000); });
  assert.equal(attempts, 2);
});

test('an error without a close event still reconnects', () => {
  renderProvider();
  act(() => socket(0).serverOpens());
  act(() => socket(0).onerror?.(new Error('Connection lost')));
  act(() => { vi.advanceTimersByTime(3000); });
  assert.equal(FakeWebSocket.instances.length, 2);
});

test('a locally closed socket that never emits close is still replaced', () => {
  renderProvider();
  act(() => socket(0).serverOpens());
  socket(0).readyState = FakeWebSocket.CLOSING;
  act(() => { vi.advanceTimersByTime(18_000); });
  assert.equal(FakeWebSocket.instances.length, 2);
  act(() => socket(1).serverOpens());
  assert.equal(isConnected, true);
});
