import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { claudeRuntime } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

// Opt-in: runs the installed CLI against a loopback-only fake Messages API.
// No external inference, credentials, production session or application files.
for (const background of [false, true]) {
  test(`real Claude CLI accepts live input with ${background ? 'background' : 'foreground'} Bash intact`, {
    skip: process.env.CLOUDCLI_TEST_CLAUDE_LIVE !== '1', timeout: 45_000,
  }, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cloudcli-claude-live-'));
    const marker = path.join(directory, 'finished');
    const sessionId = `isolated-live-${background}`;
    const requests: string[] = [];
    const frames: NormalizedMessage[] = [];
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      if (request.url?.includes('count_tokens')) {
        response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"input_tokens":10}');
        return;
      }
      const first = requests.length === 0;
      requests.push(body);
      const tool = { type: 'tool_use', id: 'toolu_local_probe', name: 'Bash', input: {
        command: `sleep 4; printf finished > '${marker}'`, description: 'Local live-input test', run_in_background: background,
      } };
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const emit = (event: { type: string; [key: string]: unknown }) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      emit({ type: 'message_start', message: { id: `msg_local_${requests.length}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
      emit({ type: 'content_block_start', index: 0, content_block: first ? { ...tool, input: {} } : { type: 'text', text: '' } });
      emit({ type: 'content_block_delta', index: 0, delta: first ? { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } : { type: 'text_delta', text: 'Local response.' } });
      emit({ type: 'content_block_stop', index: 0 });
      emit({ type: 'message_delta', delta: { stop_reason: first ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } });
      emit({ type: 'message_stop' });
      response.end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
    let queryCount = 0;
    let sending: Promise<void> | undefined;
    let acknowledgedBeforeCommandEnded = false;
    const context: ProviderRuntimeContext = {
      resolveProviderSessionId: () => null,
      resolveResumeModel: async () => 'claude-sonnet-4-6',
      getProviderModels: async () => ({ DEFAULT: 'claude-sonnet-4-6', OPTIONS: [] }),
      normalizeMessage: (raw, id) => sessions.normalizeMessage(raw, id),
      isProviderInstalled: async () => true,
      createQuery: ({ prompt, options }) => {
        queryCount++;
        const instance = query({ prompt: prompt as AsyncIterable<SDKUserMessage>, options: {
          ...options, env: { PATH: process.env.PATH, HOME: process.env.HOME, CLAUDE_CONFIG_DIR: directory,
            ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, ANTHROPIC_API_KEY: 'local-test-only',
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
          settings: {}, settingSources: [], mcpServers: {}, strictMcpConfig: true,
          tools: ['Bash'], allowedTools: ['Bash'], permissionMode: 'bypassPermissions', maxTurns: 6,
        } as Options });
        return {
          [Symbol.asyncIterator]: () => instance[Symbol.asyncIterator](),
          interrupt: async () => { await instance.interrupt(); },
          stopTask: async (taskId) => { await instance.stopTask(taskId); },
        };
      },
    };
    try {
      await claudeRuntime.run('Execute the local test command.', { sessionId, cwd: directory }, {
        send(message: NormalizedMessage) {
          frames.push(message);
          if (!sending && message.kind === (background ? 'complete' : 'tool_use')) {
            // Defer until the initial complete has finished processing its hold.
            sending = new Promise<void>((resolve) => setTimeout(resolve, 100)).then(async () => {
              await claudeRuntime.steer(sessionId, 'SUPPLEMENT_LIVE_INPUT: keep the current command running.');
              acknowledgedBeforeCommandEnded = await readFile(marker).then(() => false, () => true);
            });
            void sending.catch(() => {});
          }
        }, userId: null,
      }, context);
      assert.ok(sending, 'test submitted a live message');
      await sending;
      assert.equal(queryCount, 1, 'no replacement CLI');
      assert.equal(acknowledgedBeforeCommandEnded, true, 'CLI queue receipt arrives while Bash is still running');
      assert.equal(await readFile(marker, 'utf8'), 'finished', 'Bash was not interrupted');
      assert.ok(requests.slice(1).some((body) => body.includes('SUPPLEMENT_LIVE_INPUT')), 'model request includes the follow-up');
      assert.equal(frames.filter((frame) => frame.kind === 'error').length, 0);
      assert.equal(frames.filter((frame) => frame.kind === 'complete').length, background ? 2 : 1);
    } finally {
      await claudeRuntime.abort(sessionId);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
}
