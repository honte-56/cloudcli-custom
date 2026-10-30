import assert from 'node:assert/strict';
import { act, renderHook, render, fireEvent } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { PromptInput } from '@/modules/chat/composer/PromptInput';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { readDraftText, resetChatDrafts } from '@/shared/chatDrafts';
import type { ChatMessage, PermissionMode, Project } from '@/shared/types';

const { steerSession, uploadFiles } = vi.hoisted(() => ({ steerSession: vi.fn(), uploadFiles: vi.fn() }));
vi.mock('@/shared/api', () => {
  const ok = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });
  return { api: {
    assets: { uploadFiles },
    providers: { steerSession, skills: () => ok({ skills: [] }) },
    user: { drafts: () => ok({ drafts: [] }), saveDraft: () => ok({}), deleteDraft: () => ok({}), preferences: () => ok({ preferences: {} }), savePreferences: () => ok({}) },
    commands: { list: () => ok({ commands: [] }) },
    files: { search: () => ok({ files: [] }) },
    getFiles: () => ok([]),
  } };
});

const PROJECT = { projectId: 'p', fullPath: '/tmp/p' } as Project;

function composer(provider: 'codex' | 'claude' | 'cursor' = 'codex', background = false, send?: (message: unknown) => Promise<void>) {
  const messages: ChatMessage[] = [];
  const view = renderHook(({ session }: { session: { id: string } }) => useChatComposerState({
    selectedProject: PROJECT,
    selectedSession: session, currentSessionId: session.id,
    provider, permissionMode: 'default', cyclePermissionMode: () => {},
    resolvePermissionModeForProvider: () => 'default' as PermissionMode,
    currentProviderModel: 'test-model', currentProviderEffort: 'medium',
    isLoading: send ? false : !background, processingSessions: background ? new Map([[session.id, { background: true, canInterrupt: false, statusText: 'Running background task', startedAt: Date.now() }]]) : undefined, canAbortSession: true, tokenBudget: null,
    sendMessage: send ?? (() => { throw new Error('Steering must not start a second turn'); }),
    scrollToBottom: () => {}, addMessage: (message) => { messages.push(message as ChatMessage); },
    setIsUserScrolledUp: () => {}, setPendingPermissionRequests: () => {},
  }), { initialProps: { session: { id: 'session-a' } } });
  return { view, messages };
}

beforeEach(() => {
  localStorage.clear(); resetChatDrafts(); steerSession.mockReset(); uploadFiles.mockReset();
});

for (const provider of ['codex', 'claude'] as const) {
test(`${provider} live input is acknowledged before the draft is cleared`, async () => {
  let acknowledge!: (result: unknown) => void;
  steerSession.mockReturnValue(new Promise((resolve) => { acknowledge = resolve; }));
  const { view, messages } = composer(provider);
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

}

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

test('Claude live input is available while background work remains', async () => {
  steerSession.mockResolvedValue({ ok: true, json: async () => ({ data: { delivered: true } }) });
  const { view } = composer('claude', true);
  assert.equal(view.result.current.canSteer, true);
  await act(async () => { view.result.current.setInput('keep the background job'); });
  await act(async () => { await view.result.current.handleSteer(); });
  assert.deepEqual(steerSession.mock.calls[0], ['session-a', 'keep the background job']);
  view.unmount();
});

test('providers without live input cannot send through the steering handler', async () => {
  const { view } = composer('cursor');
  assert.equal(view.result.current.canSteer, false);
  await act(async () => { view.result.current.setInput('retain'); });
  await act(async () => { await view.result.current.handleSteer(); });
  assert.equal(steerSession.mock.calls.length, 0);
  assert.equal(view.result.current.input, 'retain');
  view.unmount();
});

for (const outcome of ['accepted', 'rejected', 'switched', 'new-text']) {
  test(`ordinary send retains the draft until receipt: ${outcome}`, async () => {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const send = vi.fn(() => new Promise<void>((yes, no) => { resolve = yes; reject = no; }));
    const { view, messages } = composer('claude', false, send);
    await act(async () => { view.result.current.setInput('original'); });
    let pending!: Promise<void>;
    act(() => { pending = view.result.current.handleSubmit({ preventDefault() {} } as never); });
    assert.equal(view.result.current.input, 'original');
    assert.equal(view.result.current.isSending, true);
    assert.equal(messages.length, 0);
    await act(async () => {
      await view.result.current.handleSubmit({ preventDefault() {} } as never);
    });
    assert.equal(send.mock.calls.length, 1);
    if (outcome === 'switched') await act(async () => { view.rerender({ session: { id: 'session-b' } }); });
    if (outcome === 'switched' || outcome === 'new-text') {
      await act(async () => { view.result.current.setInput('new draft'); });
    }
    await act(async () => {
      if (outcome === 'rejected') reject(new Error('disconnected'));
      else resolve();
      await pending;
    });
    assert.equal(view.result.current.input, outcome === 'accepted' ? '' : outcome === 'rejected' ? 'original' : 'new draft');
    assert.equal(messages.filter(m => m.type === 'user').length, ['accepted', 'new-text'].includes(outcome) ? 1 : 0);
    assert.equal(view.result.current.isSending, false);
    view.unmount();
  });
}


for (const method of ['picker', 'drop'] as const) {
  test(`${method} adds a file to the composer and sends the uploaded descriptor`, async () => {
    const send = vi.fn(async () => {});
    const { view } = composer('claude', false, send);
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    Object.defineProperty(file, 'size', { value: 22 * 1024 * 1024 });
    const attachment = { name: file.name, path: '/assets/notes.txt', mimeType: file.type, size: file.size };
    uploadFiles.mockResolvedValue({ ok: true, json: async () => ({ attachments: [attachment] }) });
    const picker = render(<PromptInput {...view.result.current.getRootProps()}>
      <input {...view.result.current.getInputProps()} data-testid="file-input" />
    </PromptInput>);
    await act(async () => {
      if (method === 'picker') {
        fireEvent.change(picker.getByTestId('file-input'), { target: { files: [file] } });
      } else {
        fireEvent.drop(picker.container.querySelector('form')!, { dataTransfer: {
          files: [file], types: ['Files'], items: [{ kind: 'file', type: file.type, getAsFile: () => file }],
        } });
      }
    });
    assert.equal(view.result.current.attachedFiles.length, 1);
    assert.equal(view.result.current.attachedFiles[0].name, 'notes.txt');
    await act(async () => { await view.result.current.handleSubmit({ preventDefault() {} } as never); });
    assert.equal(uploadFiles.mock.calls.length, 1);
    assert.equal(send.mock.calls.length, 1);
    assert.deepEqual((send.mock.calls as unknown as Array<[any]>)[0][0].options.attachments, [attachment]);
    assert.equal(view.result.current.attachedFiles.length, 0);
  });
}

test('oversized picker files produce a visible error instead of disappearing silently', async () => {
  const { view } = composer('claude', false, async () => {});
  const file = new File(['test'], 'large.zip');
  Object.defineProperty(file, 'size', { value: 101 * 1024 * 1024 });
  const picker = render(<PromptInput {...view.result.current.getRootProps()}>
    <input {...view.result.current.getInputProps()} data-testid="file-input" />
  </PromptInput>);
  await act(async () => { fireEvent.change(picker.getByTestId('file-input'), { target: { files: [file] } }); });
  assert.equal(view.result.current.attachedFiles.length, 0);
  assert.match(view.result.current.fileErrors.get(file.name) ?? '', /100MB/);
});

test('a failed upload preserves both attachment and input and enables retry', async () => {
  const send = vi.fn(async () => {});
  const { view, messages } = composer('claude', false, send);
  const file = new File(['hello'], 'notes.txt');
  await act(async () => {
    view.result.current.setInput('read this');
    view.result.current.setAttachedFiles([file]);
  });
  uploadFiles.mockRejectedValue(new Error('File upload timed out. Please retry.'));
  await act(async () => { await view.result.current.handleSubmit({ preventDefault() {} } as never); });
  assert.equal(view.result.current.input, 'read this');
  assert.deepEqual(view.result.current.attachedFiles, [file]);
  assert.equal(view.result.current.isSending, false);
  assert.equal(send.mock.calls.length, 0);
  assert.match(String(messages.at(-1)?.content), /timed out/);
});
