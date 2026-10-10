import assert from 'node:assert/strict';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { readDraftText, resetChatDrafts } from '@/shared/chatDrafts';
import type { ChatMessage, PermissionMode, Project } from '@/shared/types';

const { steerSession } = vi.hoisted(() => ({ steerSession: vi.fn() }));
vi.mock('@/shared/api', () => {
  const ok = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });
  return { api: {
    providers: { steerSession, skills: () => ok({ skills: [] }) },
    user: { drafts: () => ok({ drafts: [] }), saveDraft: () => ok({}), deleteDraft: () => ok({}), preferences: () => ok({ preferences: {} }), savePreferences: () => ok({}) },
    commands: { list: () => ok({ commands: [] }) },
    files: { search: () => ok({ files: [] }) },
    getFiles: () => ok([]),
  } };
});

const PROJECT = { projectId: 'p', fullPath: '/tmp/p' } as Project;

function composer() {
  const messages: ChatMessage[] = [];
  const view = renderHook(({ session }: { session: { id: string } }) => useChatComposerState({
    selectedProject: PROJECT,
    selectedSession: session, currentSessionId: session.id,
    provider: 'codex', permissionMode: 'default', cyclePermissionMode: () => {},
    resolvePermissionModeForProvider: () => 'default' as PermissionMode,
    currentProviderModel: 'test-model', currentProviderEffort: 'medium',
    isLoading: true, canAbortSession: true, tokenBudget: null,
    sendMessage: () => { throw new Error('Steering must not start a second turn'); },
    scrollToBottom: () => {}, addMessage: (message) => { messages.push(message as ChatMessage); },
    setIsUserScrolledUp: () => {}, setPendingPermissionRequests: () => {},
  }), { initialProps: { session: { id: 'session-a' } } });
  return { view, messages };
}

beforeEach(() => {
  localStorage.clear(); resetChatDrafts(); steerSession.mockReset();
});

test('live input is acknowledged before the draft is cleared', async () => {
  let acknowledge!: (result: unknown) => void;
  steerSession.mockReturnValue(new Promise((resolve) => { acknowledge = resolve; }));
  const { view, messages } = composer();
  await act(async () => { view.result.current.setInput('change direction'); });
  let pending!: Promise<void>;
  act(() => { pending = view.result.current.handleSteer(); });
  assert.equal(view.result.current.input, 'change direction');
  assert.equal(messages.length, 0);
  await act(async () => {
    // Fast repeated clicks cannot send the same input twice.
    await view.result.current.handleSteer();
    acknowledge({ ok: true, json: async () => ({ data: { delivered: true } }) });
    await pending;
  });
  assert.equal(steerSession.mock.calls.length, 1);
  assert.deepEqual(steerSession.mock.calls[0], ['session-a', 'change direction']);
  assert.equal(view.result.current.input, '');
  assert.equal(readDraftText('session-a'), '');
  assert.equal(messages[0].type, 'user');
  view.unmount();
});

test('a rejected or unconfirmed send retains the draft and shows the error', async () => {
  steerSession.mockResolvedValue({ ok: false, json: async () => ({ error: { message: 'No active turn' } }) });
  const { view, messages } = composer();
  await act(async () => { view.result.current.setInput('do not lose this'); });
  await act(async () => { await view.result.current.handleSteer(); });
  assert.equal(view.result.current.input, 'do not lose this');
  assert.equal(readDraftText('session-a'), 'do not lose this');
  assert.equal(messages[0].type, 'error');
  assert.equal(messages[0].content, 'No active turn');
  view.unmount();
});

for (const switched of [false, true]) {
  test(`a late acknowledgement preserves ${switched ? 'another session' : 'new typing'}`, async () => {
    let acknowledge!: (result: unknown) => void;
    steerSession.mockReturnValue(new Promise((resolve) => { acknowledge = resolve; }));
    const { view, messages } = composer();
    await act(async () => { view.result.current.setInput('original'); });
    let pending!: Promise<void>;
    act(() => { pending = view.result.current.handleSteer(); });
    await act(async () => {
      if (switched) view.rerender({ session: { id: 'session-b' } });
    });
    await act(async () => { view.result.current.setInput('new draft'); });
    await act(async () => {
      acknowledge({ ok: true, json: async () => ({ data: { delivered: true } }) });
      await pending;
    });
    assert.equal(view.result.current.input, 'new draft');
    assert.equal(readDraftText(switched ? 'session-b' : 'session-a'), 'new draft');
    assert.equal(messages.filter((message) => message.type === 'user').length, switched ? 0 : 1);
    view.unmount();
  });
}
