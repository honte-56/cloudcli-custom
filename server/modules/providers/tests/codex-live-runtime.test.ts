import assert from 'node:assert/strict';
import test from 'node:test';

import { createCodexLiveRuntime } from '@/modules/providers/list/codex/codex-live-runtime.provider.js';
import type { AnyRecord, ProviderRuntimeContext } from '@/shared/types.js';

function fixture(resumed = false) {
  let notify!: (method: string, params: AnyRecord) => void;
  const calls: Array<{ method: string; params: AnyRecord }> = [];
  const messages: AnyRecord[] = [];
  let rejectSteer = false;
  let closed = false;
  const runtime = createCodexLiveRuntime((notification) => {
    notify = notification;
    return {
      initialize: async () => {},
      close: () => { closed = true; },
      async call(method, params) {
        calls.push({ method, params });
        if (method.startsWith('thread/')) return { thread: { id: 'native-thread' } };
        if (method === 'turn/start') {
          notify('turn/started', { threadId: 'native-thread', turn: { id: 'turn-1' } });
          return { turn: { id: 'turn-1', status: 'inProgress' } };
        }
        if (rejectSteer) throw new Error('No active turn to steer');
        return { turnId: 'turn-1' };
      },
    };
  });
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => resumed ? 'native-thread' : null,
    resolveResumeModel: async () => 'test-model',
    getProviderModels: async () => ({ DEFAULT: 'test-model', OPTIONS: [] }),
    normalizeMessage: (raw) => [{ ...(raw as AnyRecord), kind: 'tool_use' } as never],
    isProviderInstalled: async () => true,
  };
  return { runtime, context, calls, messages, notify: (method: string, params: AnyRecord) => notify(method, params), rejectSteer: () => { rejectSteer = true; }, closed: () => closed };
}

for (const resumed of [false, true]) {
  test(`live ${resumed ? 'resumed' : 'new'} run steers the same turn and completes only once`, async () => {
    const f = fixture(resumed);
    const running = f.runtime.run('initial prompt', { sessionId: 'app-id', cwd: '/tmp' }, { isWebSocketWriter: true, send: (message) => f.messages.push(message as AnyRecord) }, f.context);
    await new Promise(setImmediate);
    await f.runtime.steer('app-id', 'change direction');
    assert.equal(f.calls[0].method, resumed ? 'thread/resume' : 'thread/start');
    assert.equal(f.calls[0].params.approvalPolicy, 'on-request');
    assert.equal(f.calls[0].params.sandbox, 'workspace-write');
    assert.deepEqual(f.calls.at(-1), { method: 'turn/steer', params: { threadId: 'native-thread', expectedTurnId: 'turn-1', input: [{ type: 'text', text: 'change direction', text_elements: [] }] } });
    assert.equal(f.calls.filter((call) => call.method === 'turn/start').length, 1);
    assert.equal(f.closed(), false);
    assert.equal(f.messages.filter((message) => message.kind === 'complete').length, 0);
    f.notify('turn/completed', { threadId: 'other-thread', turn: { id: 'turn-1', status: 'completed' } });
    await f.runtime.steer('app-id', 'still active');
    f.notify('turn/completed', { threadId: 'native-thread', turn: { id: 'turn-1', status: 'completed' } });
    await running;
    assert.equal(f.messages.filter((message) => message.kind === 'complete').length, 1);
    assert.equal(f.closed(), true);
    await assert.rejects(f.runtime.steer('app-id', 'too late'));
  });
}

test('a rejected steer neither completes nor restarts the active run', async () => {
  const f = fixture();
  const running = f.runtime.run('initial', { sessionId: 'app-id' }, { isWebSocketWriter: true, send: (message) => f.messages.push(message as AnyRecord) }, f.context);
  await new Promise(setImmediate);
  f.rejectSteer();
  await assert.rejects(f.runtime.steer('app-id', 'follow-up'), /No active turn/);
  assert.equal(f.messages.some((message) => message.kind === 'complete'), false);
  assert.equal(f.calls.filter((call) => call.method === 'turn/start').length, 1);
  assert.equal(f.runtime.abort('app-id'), true);
  await running;
  assert.equal(f.closed(), true);
  assert.equal(f.messages.some((message) => message.kind === 'complete'), false);
});

test('failed turns report failure and progressive tool output keeps stable ids', async () => {
  const f = fixture();
  const running = f.runtime.run('initial', { sessionId: 'app-id' }, { isWebSocketWriter: true, send: (message) => f.messages.push(message as AnyRecord) }, f.context);
  await new Promise(setImmediate);
  f.notify('item/started', { threadId: 'native-thread', item: { id: 'cmd-1', type: 'commandExecution', command: 'pwd', status: 'inProgress' } });
  f.notify('item/commandExecution/outputDelta', { threadId: 'native-thread', itemId: 'cmd-1', delta: '/tmp' });
  f.notify('item/completed', { threadId: 'native-thread', item: { id: 'cmd-1', type: 'commandExecution', command: 'pwd', aggregatedOutput: '/tmp', status: 'completed', exitCode: 0 } });
  f.notify('turn/completed', { threadId: 'native-thread', turn: { id: 'turn-1', status: 'failed', error: { message: 'API failure' } } });
  await running;
  const tools = f.messages.filter((message) => message.itemId === 'cmd-1');
  assert.equal(tools.length, 3);
  assert.equal(tools[1].output, '/tmp');
  assert.ok(f.messages.some((message) => message.kind === 'error' && message.content === 'API failure'));
  assert.ok(f.messages.some((message) => message.kind === 'complete' && message.exitCode === 1));
});
