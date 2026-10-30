/** SDK/CLI boundary checks: each supported runtime must deliver project authentication to its child. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { queryClaudeSDK } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { codexRuntime } from '@/modules/providers/list/codex/codex-runtime.provider.js';
import { cursorRuntime } from '@/modules/providers/list/cursor/cursor-runtime.provider.js';
import { opencodeRuntime } from '@/modules/providers/list/opencode/opencode-runtime.provider.js';
import { CodexLiveClient } from '@/modules/providers/list/codex/codex-live.client.js';
import { createCodexLiveRuntime } from '@/modules/providers/list/codex/codex-live-runtime.provider.js';
import type { ProviderRuntimeContext } from '@/shared/index.js';
const context: ProviderRuntimeContext = { resolveProviderSessionId: () => null, resolveResumeModel: async () => undefined, getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'test' }), normalizeMessage: () => [], isProviderInstalled: async () => true };
const writer = { send() {}, isWebSocketWriter: true };

test('Claude SDK receives run-local environment', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-env-'));
  let captured: any;
  try {
    await queryClaudeSDK('hello', { cwd: root, environment: { ...process.env, GH_TOKEN: 'fixture-claude' } }, writer, {
      ...context, createQuery: ({ options }: any) => {
        captured = options.env;
        return Object.assign((async function* () { yield { type: 'result', subtype: 'success', session_id: 'fixture-session', result: 'done' }; })(), { interrupt: async () => {} });
      },
    });
    assert.equal(captured?.GH_TOKEN, 'fixture-claude');
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const provider of ['codex', 'cursor', 'opencode'] as const) {
  test(`${provider} CLI receives authentication without putting it into arguments`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cli-env-'));
    const previousPath = process.env.PATH, previousCodex = process.env.CLOUDCLI_CODEX_PATH, previousRuntime = process.env.CLOUDCLI_CODEX_RUNTIME;
    const executable = path.join(root, provider === 'cursor' ? 'cursor-agent' : provider);
    const capture = path.join(root, 'capture.json');
    await writeFile(executable, `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify({token: process.env.GH_TOKEN, args: process.argv.slice(2)}));\nconsole.log(JSON.stringify({type:'thread.started',thread_id:'fixture-thread'}));\nconsole.log(JSON.stringify({type:'result',subtype:'success',session_id:'fixture-session',result:'done'}));\n`, { mode: 0o755 });
    process.env.PATH = `${root}${path.delimiter}${previousPath}`;
    process.env.CLOUDCLI_CODEX_PATH = executable;
    process.env.CLOUDCLI_CODEX_RUNTIME = 'exec';
    try {
      const runtime = { codex: codexRuntime, cursor: cursorRuntime, opencode: opencodeRuntime }[provider];
      await runtime.run('hello', { cwd: root, environment: { ...process.env, GH_TOKEN: `fixture-${provider}` } }, writer, context);
      const result = JSON.parse(await readFile(capture, 'utf8'));
      assert.equal(result.token, `fixture-${provider}`);
      assert.ok(!JSON.stringify(result.args).includes(`fixture-${provider}`));
      if (provider === 'codex') assert.ok(result.args.some((arg: string) => arg.includes('shell_environment_policy.ignore_default_excludes=true')));
    } finally {
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
      if (previousCodex === undefined) delete process.env.CLOUDCLI_CODEX_PATH; else process.env.CLOUDCLI_CODEX_PATH = previousCodex;
      if (previousRuntime === undefined) delete process.env.CLOUDCLI_CODEX_RUNTIME; else process.env.CLOUDCLI_CODEX_RUNTIME = previousRuntime;
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('Codex live client passes environment through a real app-server subprocess', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'live-env-'));
  const script = path.join(root, 'rpc.cjs');
  await writeFile(script, `require('readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line); if(r.id!==undefined) console.log(JSON.stringify({id:r.id,result:{token:process.env.GH_TOKEN}}));});`);
  const client = new CodexLiveClient(() => {}, () => {}, script, { ...process.env, GH_TOKEN: 'fixture-live' });
  try { assert.equal((await client.call('fixture', {})).token, 'fixture-live'); }
  finally { client.close(); await rm(root, { recursive: true, force: true }); }
});

test('Codex live runtime forwards run-local credentials and enables shell inheritance on start and resume', async () => {
  for (const resumed of [false, true]) {
    let environment: NodeJS.ProcessEnv | undefined;
    let config: any;
    const runtime = createCodexLiveRuntime((notify, _fail, env) => {
      environment = env;
      return { initialize: async () => {}, close() {}, async call(method, params) {
        if (method.startsWith('thread/')) { config = params.config; return { thread: { id: 'thread' } }; }
        notify('turn/completed', { turn: { id: 'turn', status: 'completed' } });
        return { turn: { status: 'completed' } };
      } };
    });
    await runtime.run('hello', { cwd: '/tmp', environment: { GH_TOKEN: 'fixture-live' } }, writer, { ...context, resolveProviderSessionId: () => resumed ? 'thread' : null });
    assert.equal(environment?.GH_TOKEN, 'fixture-live');
    assert.equal(config['shell_environment_policy.ignore_default_excludes'], true);
  }
});
