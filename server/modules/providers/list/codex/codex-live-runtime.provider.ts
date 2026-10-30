import { randomUUID } from 'node:crypto';

import { CodexLiveClient } from '@/modules/providers/list/codex/codex-live.client.js';
import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import { appendFilesInputTag, buildCodexInputItems, createCompleteMessage, createNormalizedMessage } from '@/shared/index.js';
import type { AnyRecord, ProviderRuntimeContext, ProviderRuntimeWriter } from '@/shared/types.js';

// Each run owns its child and map entry. An old run's cleanup cannot close or
// remove the newer run that a queued follow-up may already have started.
type LiveClient = Pick<CodexLiveClient, 'initialize' | 'call' | 'close'>;
type LiveRun = { client: LiveClient; threadId: string | null; turnId: string | null; aborted: boolean; cancel: () => void };

function transformItem(item: AnyRecord): AnyRecord | null {
  const base = { type: 'item', itemId: item.id, status: item.status === 'inProgress' ? 'in_progress' : item.status };
  switch (item.type) {
    case 'agentMessage': return { ...base, itemType: 'agent_message', message: { content: item.text } };
    case 'reasoning': return { ...base, itemType: 'reasoning', message: { content: [...(item.summary || []), ...(item.content || [])].join('\n') } };
    case 'commandExecution': return { ...base, itemType: 'command_execution', command: item.command, output: item.aggregatedOutput || '', exitCode: item.exitCode };
    case 'fileChange': return { ...base, itemType: 'file_change', changes: item.changes.map((change: AnyRecord) => ({ ...change, kind: change.kind?.type || change.kind })) };
    case 'mcpToolCall': return { ...base, itemType: 'mcp_tool_call', server: item.server, tool: item.tool, arguments: item.arguments, result: item.result, error: item.error };
    case 'webSearch': return { ...base, itemType: 'web_search', query: item.action?.query || '' };
    // User echoes already exist in the composer; hooks are not user messages.
    case 'userMessage': case 'hookPrompt': return null;
    default: return { ...base, itemType: item.type, item };
  }
}

function turnInput(command: string, options: AnyRecord): AnyRecord[] {
  return buildCodexInputItems(appendFilesInputTag(command, options.files), options.images, options.cwd)
    .map((item) => item.type === 'text'
      ? { type: 'text', text: item.text, text_elements: [] }
      : { type: 'localImage', path: item.path });
}

/** Used by the Codex adapter and provider tests to build an isolated live runtime. */
export function createCodexLiveRuntime(
  makeClient: (notification: (method: string, params: AnyRecord) => void, failure: (error: Error) => void, environment?: NodeJS.ProcessEnv) => LiveClient =
    (notification, failure, environment) => new CodexLiveClient(notification, failure, undefined, environment),
) {
const runs = new Map<string, LiveRun>();
async function runLive(command: string, options: AnyRecord, writer: ProviderRuntimeWriter, context: ProviderRuntimeContext): Promise<void> {
  const key = options.sessionId || randomUUID();
  let finish!: (turn: AnyRecord) => void;
  let fail!: (error: Error) => void;
  const completion = new Promise<AnyRecord>((resolve, reject) => { finish = resolve; fail = reject; });
  // A process error can arrive during initialization, before completion is awaited.
  void completion.catch(() => {});
  const send = (message: unknown) => writer.send(writer.isWebSocketWriter ? message : JSON.stringify(message));
  const items = new Map<string, AnyRecord>();
  const run: LiveRun = { client: null as unknown as LiveClient, threadId: null, turnId: null, aborted: false, cancel: () => finish({ status: 'interrupted' }) };
  const normalizeItem = (item: AnyRecord) => {
    const raw = transformItem(item);
    if (raw) for (const message of context.normalizeMessage(raw, run.threadId || key)) send(message);
  };
  try {
    run.client = makeClient((method, params) => {
      if (params.threadId && run.threadId && params.threadId !== run.threadId) return;
      if (method === 'turn/started') run.turnId = params.turn.id;
      if (method === 'turn/completed') {
        if (run.turnId && params.turn.id !== run.turnId) return;
        run.turnId = null;
        finish(params.turn);
      }
      if (method === 'item/started' || method === 'item/completed') {
        const item = params.item;
        // Store only running tools, bounded independently of conversation length.
        if (method === 'item/started' && ['commandExecution', 'mcpToolCall'].includes(item.type)) {
          if (items.size < 256) items.set(item.id, item);
          normalizeItem(item);
        } else if (method === 'item/completed') {
          items.delete(item.id);
          normalizeItem(item);
        }
      }
      if (method === 'item/commandExecution/outputDelta') {
        const item = items.get(params.itemId);
        if (item) {
          item.aggregatedOutput = ((item.aggregatedOutput || '') + params.delta).slice(-1024 * 1024);
          normalizeItem(item);
        }
      }
      if (method === 'turn/plan/updated') {
        for (const message of context.normalizeMessage({ type: 'item', itemType: 'todo_list', itemId: `${params.turnId}-plan`, items: params.plan.map((step: AnyRecord) => ({ text: step.step, completed: step.status === 'completed' })) }, run.threadId || key)) send(message);
      }
      if (method === 'thread/tokenUsage/updated') {
        const usage = params.tokenUsage;
        send(createNormalizedMessage({ kind: 'status', text: 'token_budget', provider: 'codex', sessionId: run.threadId || key, tokenBudget: { used: usage.total.totalTokens, total: usage.modelContextWindow || 200000, inputTokens: usage.total.inputTokens, outputTokens: usage.total.outputTokens, breakdown: { input: usage.total.inputTokens, output: usage.total.outputTokens } } }));
      }
      if (method === 'error' && !params.willRetry) fail(new Error(params.error?.message || 'Codex run failed'));
    }, fail, options.environment);
    runs.set(key, run);
    await run.client.initialize();
    const model = await context.resolveResumeModel(options.sessionId, options.model);
    const catalog = await context.getProviderModels();
    const allowedEfforts = catalog.OPTIONS.find((entry) => entry.value === model)?.effort?.values?.map((entry) => entry.value) || [];
    const nativeId = context.resolveProviderSessionId(options.sessionId);
    const bypass = options.permissionMode === 'bypassPermissions';
    const thread = await run.client.call(nativeId ? 'thread/resume' : 'thread/start', {
      ...(nativeId ? { threadId: nativeId } : {}), model,
      ...(options.environment ? { config: { 'shell_environment_policy.ignore_default_excludes': true } } : {}),
      cwd: options.cwd || options.projectPath || process.cwd(),
      sandbox: bypass ? 'danger-full-access' : 'workspace-write',
      approvalPolicy: bypass || options.permissionMode === 'acceptEdits' ? 'never' : 'on-request',
    });
    if (typeof thread.thread?.id !== 'string') throw new Error('Codex returned no thread id.');
    const threadId: string = thread.thread.id;
    run.threadId = threadId;
    writer.setSessionId?.(threadId);
    if (!nativeId) send(createNormalizedMessage({ kind: 'session_created', provider: 'codex', sessionId: run.threadId, newSessionId: run.threadId }));
    if (run.aborted) return;
    const started = await run.client.call('turn/start', { threadId: run.threadId, input: turnInput(command, options), ...(allowedEfforts.includes(options.effort) ? { effort: options.effort } : {}) });
    // The started notification may precede the response; a very fast turn may
    // even finish first. Do not resurrect its id after completion.
    if (started.turn.status === 'inProgress' && run.turnId) run.turnId = started.turn.id;
    const turn = await completion;
    if (!run.aborted) {
      if (turn.status === 'failed') throw new Error(turn.error?.message || 'Codex turn failed');
      const interrupted = turn.status === 'interrupted';
      send(createCompleteMessage({ provider: 'codex', sessionId: run.threadId, actualSessionId: run.threadId, exitCode: 0, ...(interrupted ? { aborted: true } : {}) }));
      if (!interrupted) notifyRunStopped({ userId: writer.userId || null, provider: 'codex', sessionId: key, sessionName: options.sessionSummary, stopReason: 'completed' });
    }
  } catch (error) {
    if (!run.aborted) {
      send(createNormalizedMessage({ kind: 'error', provider: 'codex', sessionId: run.threadId || key, content: error instanceof Error ? error.message : String(error) }));
      send(createCompleteMessage({ provider: 'codex', sessionId: run.threadId || key, exitCode: 1 }));
      notifyRunFailed({ userId: writer.userId || null, provider: 'codex', sessionId: key, sessionName: options.sessionSummary, error });
    }
  } finally {
    run.client?.close();
    if (runs.get(key) === run) runs.delete(key);
  }
}

return {
  run: runLive,
  abort(sessionId: string): boolean {
    const run = runs.get(sessionId);
    if (!run) return false;
    run.aborted = true;
    // Closing this run's child cancels initialization as well as active tools.
    run.client.close();
    run.cancel();
    return true;
  },
  async steer(sessionId: string, content: string): Promise<void> {
    const run = runs.get(sessionId);
    if (!run?.threadId || !run.turnId || run.aborted) throw new Error('当前任务尚未开始或已经结束，请稍后重试或使用普通发送。');
    await run.client.call('turn/steer', { threadId: run.threadId, expectedTurnId: run.turnId, input: [{ type: 'text', text: content, text_elements: [] }] });
  },
};
}

/** Used by the Codex provider for app-server turns and in-place steering. */
export const codexLiveRuntime = createCodexLiveRuntime();
