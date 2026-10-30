import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createProviderPlanUsageService,
  parseClaudeUsageBody,
  parseCodexRateLimits,
} from '@/modules/providers/services/provider-plan-usage.service.js';

const NOW = Date.parse('2026-10-30T00:00:00.000Z');

function claudeCredentials(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: 'secret-token',
      expiresAt: NOW + 3_600_000,
      subscriptionType: 'max',
      ...overrides,
    },
  });
}

test('parseClaudeUsageBody keeps known windows in order and clamps percentages', () => {
  const windows = parseClaudeUsageBody({
    seven_day: { utilization: 120, resets_at: '2026-11-02T00:00:00Z' },
    five_hour: { utilization: 41.5, resets_at: '2026-10-30T03:00:00Z' },
    seven_day_opus: null,
    unrelated: { utilization: 5 },
  });

  assert.deepEqual(windows.map((w) => [w.id, w.usedPercent]), [['five_hour', 41.5], ['weekly', 100]]);
  assert.equal(windows[0].resetsAt, '2026-10-30T03:00:00.000Z');
});

test('parseCodexRateLimits reports an already-reset window as unused', () => {
  const result = parseCodexRateLimits({
    plan_type: 'pro',
    primary: { used_percent: 94, window_minutes: 10080, resets_at: Math.floor(NOW / 1000) - 60 },
    secondary: { used_percent: 10, window_minutes: 300, resets_at: Math.floor(NOW / 1000) + 600 },
    credits: { balance: '12.5', unlimited: false },
  }, '2026-10-29T00:00:00.000Z', NOW);

  assert.equal(result.planName, 'Pro');
  assert.deepEqual(result.windows.map((w) => [w.id, w.usedPercent]), [['weekly', 0], ['five_hour', 10]]);
  assert.equal(result.windows[0].resetsAt, null);
  assert.deepEqual(result.credits, { balance: '12.5', unlimited: false });
});

test('Claude usage is fetched with the stored token, cached, and never echoes the token', async () => {
  let calls = 0;
  const service = createProviderPlanUsageService({
    now: () => NOW,
    getHomeDirectory: () => '/home/test',
    readTextFile: async () => claudeCredentials(),
    fetchJson: async (_url, init) => {
      calls += 1;
      assert.equal(init.headers.Authorization, 'Bearer secret-token');
      return { status: 200, body: { five_hour: { utilization: 20, resets_at: '2026-10-30T03:00:00Z' } } };
    },
  });

  const first = await service.getPlanUsage('claude');
  await service.getPlanUsage('claude');

  assert.equal(calls, 1);
  assert.equal(first.status, 'ok');
  assert.equal(first.planName, 'Max');
  assert.equal(JSON.stringify(first).includes('secret-token'), false);
});

test('Claude usage reports an expired token without calling the network', async () => {
  const service = createProviderPlanUsageService({
    now: () => NOW,
    readTextFile: async () => claudeCredentials({ expiresAt: NOW - 1 }),
    fetchJson: async () => {
      throw new Error('must not be called');
    },
  });

  assert.equal((await service.getPlanUsage('claude')).status, 'token-expired');
});

test('Claude usage reports unauthenticated when credentials are missing', async () => {
  const service = createProviderPlanUsageService({
    readTextFile: async () => {
      throw new Error('ENOENT');
    },
  });

  assert.equal((await service.getPlanUsage('claude')).status, 'unauthenticated');
});

test('Claude usage maps a rejected token to token-expired', async () => {
  const service = createProviderPlanUsageService({
    now: () => NOW,
    readTextFile: async () => claudeCredentials(),
    fetchJson: async () => ({ status: 401, body: null }),
  });

  assert.equal((await service.getPlanUsage('claude')).status, 'token-expired');
});

test('Codex usage reads the newest rate_limits event from the newest session file', async () => {
  const event = (used: number) => JSON.stringify({
    timestamp: '2026-10-29T10:00:00.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        plan_type: 'pro',
        primary: { used_percent: used, window_minutes: 10080, resets_at: Math.floor(NOW / 1000) + 86_400 },
        secondary: null,
      },
    },
  });
  const dirent = (name: string, dir: boolean) => ({ name, isDirectory: () => dir }) as never;

  const service = createProviderPlanUsageService({
    now: () => NOW,
    getHomeDirectory: () => '/home/test',
    readDirectory: async (directory) => (
      directory.endsWith('sessions') ? [dirent('old.jsonl', false), dirent('new.jsonl', false)] : []
    ),
    statMtimeMs: async (file) => (file.endsWith('new.jsonl') ? 2 : 1),
    readTextFileTail: async (file) => ({
      content: file.endsWith('new.jsonl') ? `${event(30)}\n${event(55)}\nnot json` : event(1),
      isComplete: true,
    }),
  });

  const result = await service.getPlanUsage('codex');
  assert.equal(result.status, 'ok');
  assert.equal(result.windows[0].usedPercent, 55);
  assert.equal(result.source, 'session-log');
});

test('unknown providers are rejected and cursor is unsupported', async () => {
  const service = createProviderPlanUsageService();
  assert.equal((await service.getPlanUsage('cursor')).status, 'unsupported');
  await assert.rejects(() => service.getPlanUsage('nope'));
});
