import type { Dirent } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AnyRecord } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

export type PlanUsageWindow = {
  id: string;
  /** Length of the rate-limit window in minutes, when the provider reports it. */
  windowMinutes: number | null;
  usedPercent: number;
  /** ISO timestamp at which the window resets, or null when unknown. */
  resetsAt: string | null;
};

export type PlanUsageStatus = 'ok' | 'unauthenticated' | 'token-expired' | 'unsupported' | 'error';

export type PlanUsageResult = {
  provider: string;
  status: PlanUsageStatus;
  planName: string | null;
  windows: PlanUsageWindow[];
  credits: { balance: string | null; unlimited: boolean } | null;
  /** 'live' = fetched from the provider now, 'session-log' = last value the CLI logged. */
  source: 'live' | 'session-log' | null;
  /** ISO timestamp of the data (fetch time for live, event time for session-log). */
  fetchedAt: string | null;
  message?: string;
};

type FileTail = { content: string; isComplete: boolean };

type ProviderPlanUsageServiceDependencies = {
  getHomeDirectory: () => string;
  now: () => number;
  readTextFile: (filePath: string) => Promise<string>;
  readTextFileTail: (filePath: string, maxBytes: number) => Promise<FileTail>;
  readDirectory: (directoryPath: string) => Promise<Dirent[]>;
  statMtimeMs: (filePath: string) => Promise<number>;
  fetchJson: (url: string, init: { headers: Record<string, string>; timeoutMs: number }) => Promise<{
    status: number;
    body: unknown;
  }>;
};

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_USAGE_CACHE_MS = 60_000;
const CLAUDE_USAGE_TIMEOUT_MS = 5_000;
const CODEX_LOG_TAIL_BYTES = 1024 * 1024;
/** How many of the newest Codex session files are searched for a rate-limit snapshot. */
const CODEX_MAX_FILES_SCANNED = 8;

/** Display order for the Claude windows the usage endpoint may return. */
const CLAUDE_WINDOWS: Array<{ key: string; id: string; windowMinutes: number }> = [
  { key: 'five_hour', id: 'five_hour', windowMinutes: 300 },
  { key: 'seven_day', id: 'weekly', windowMinutes: 10_080 },
  { key: 'seven_day_opus', id: 'weekly_opus', windowMinutes: 10_080 },
  { key: 'seven_day_sonnet', id: 'weekly_sonnet', windowMinutes: 10_080 },
];

const defaultDependencies: ProviderPlanUsageServiceDependencies = {
  getHomeDirectory: () => os.homedir(),
  now: () => Date.now(),
  readTextFile: (filePath) => fsp.readFile(filePath, 'utf8'),
  readTextFileTail: async (filePath, maxBytes) => {
    const handle = await fsp.open(filePath, 'r');
    try {
      const { size } = await handle.stat();
      if (size <= maxBytes) {
        return { content: await handle.readFile({ encoding: 'utf8' }), isComplete: true };
      }

      const buffer = Buffer.alloc(maxBytes);
      await handle.read(buffer, 0, maxBytes, size - maxBytes);
      const content = buffer.toString('utf8');
      // Drop the partial first row (and any split multi-byte character with it).
      const firstNewline = content.indexOf('\n');
      return {
        content: firstNewline === -1 ? '' : content.slice(firstNewline + 1),
        isComplete: false,
      };
    } finally {
      await handle.close();
    }
  },
  readDirectory: (directoryPath) => fsp.readdir(directoryPath, { withFileTypes: true }),
  statMtimeMs: async (filePath) => (await fsp.stat(filePath)).mtimeMs,
  fetchJson: async (url, { headers, timeoutMs }) => {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // A non-JSON error body carries nothing we can show.
    }
    return { status: response.status, body };
  },
};

function emptyResult(provider: string, status: PlanUsageStatus, message?: string): PlanUsageResult {
  return {
    provider,
    status,
    planName: null,
    windows: [],
    credits: null,
    source: null,
    fetchedAt: null,
    ...(message ? { message } : {}),
  };
}

function readFiniteNumber(value: unknown): number | null {
  const parsed = typeof value === 'string' && value.trim() === '' ? NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function toIsoFromEpochSeconds(value: unknown): string | null {
  const seconds = readFiniteNumber(value);
  return seconds === null ? null : new Date(seconds * 1000).toISOString();
}

function toIsoFromDateLike(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/** "pro" -> "Pro", "max_5x" -> "Max 5x". */
function formatPlanName(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) {
    return null;
  }
  return raw
    .trim()
    .split(/[_\s-]+/)
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(' ');
}

/**
 * Maps the Claude `/api/oauth/usage` body to windows. Every field is read
 * defensively because the endpoint is not a documented API.
 */
export function parseClaudeUsageBody(body: unknown): PlanUsageWindow[] {
  if (!body || typeof body !== 'object') {
    return [];
  }

  const record = body as AnyRecord;
  const windows: PlanUsageWindow[] = [];
  for (const definition of CLAUDE_WINDOWS) {
    const entry = record[definition.key];
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const utilization = readFiniteNumber((entry as AnyRecord).utilization);
    if (utilization === null) {
      continue;
    }
    windows.push({
      id: definition.id,
      windowMinutes: definition.windowMinutes,
      usedPercent: clampPercent(utilization),
      resetsAt: toIsoFromDateLike((entry as AnyRecord).resets_at),
    });
  }
  return windows;
}

/**
 * Maps a Codex `rate_limits` object (from a `token_count` event) to a result.
 * A window whose reset time has already passed is reported as 0% used: the
 * logged percentage describes the old window.
 */
export function parseCodexRateLimits(
  rateLimits: AnyRecord,
  loggedAt: string | null,
  nowMs: number,
): PlanUsageResult {
  const windows: PlanUsageWindow[] = [];
  for (const [slot, id] of [['primary', 'primary'], ['secondary', 'secondary']] as const) {
    const entry = rateLimits[slot];
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const used = readFiniteNumber((entry as AnyRecord).used_percent);
    if (used === null) {
      continue;
    }
    const windowMinutes = readFiniteNumber((entry as AnyRecord).window_minutes);
    const resetsAt = toIsoFromEpochSeconds((entry as AnyRecord).resets_at);
    const expired = resetsAt !== null && Date.parse(resetsAt) <= nowMs;
    windows.push({
      id: windowMinutes === 10_080 ? 'weekly' : windowMinutes === 300 ? 'five_hour' : id,
      windowMinutes,
      usedPercent: expired ? 0 : clampPercent(used),
      resetsAt: expired ? null : resetsAt,
    });
  }

  const credits = rateLimits.credits && typeof rateLimits.credits === 'object'
    ? rateLimits.credits as AnyRecord
    : null;

  return {
    provider: 'codex',
    status: 'ok',
    planName: formatPlanName(rateLimits.plan_type),
    windows,
    credits: credits
      ? {
          balance: typeof credits.balance === 'string' || typeof credits.balance === 'number'
            ? String(credits.balance)
            : null,
          unlimited: credits.unlimited === true,
        }
      : null,
    source: 'session-log',
    fetchedAt: loggedAt,
  };
}

export function createProviderPlanUsageService(
  overrides: Partial<ProviderPlanUsageServiceDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...overrides };
  let claudeCache: { expiresAt: number; result: PlanUsageResult } | null = null;
  let claudeInFlight: Promise<PlanUsageResult> | null = null;

  async function fetchClaudeUsage(): Promise<PlanUsageResult> {
    const credentialsPath = path.join(dependencies.getHomeDirectory(), '.claude', '.credentials.json');
    let oauth: AnyRecord | null = null;
    try {
      const parsed = JSON.parse(await dependencies.readTextFile(credentialsPath)) as AnyRecord;
      oauth = parsed.claudeAiOauth && typeof parsed.claudeAiOauth === 'object'
        ? parsed.claudeAiOauth as AnyRecord
        : null;
    } catch {
      // Missing or unreadable credentials mean there is no subscription login here.
    }

    const accessToken = typeof oauth?.accessToken === 'string' ? oauth.accessToken : '';
    if (!oauth || !accessToken) {
      return emptyResult(
        'claude',
        'unauthenticated',
        'No Claude subscription login was found on this server.',
      );
    }

    const planName = formatPlanName(oauth.subscriptionType);
    const expiresAt = readFiniteNumber(oauth.expiresAt);
    if (expiresAt !== null && expiresAt <= dependencies.now()) {
      // Refresh tokens rotate; refreshing here could invalidate the CLI's own login.
      return { ...emptyResult('claude', 'token-expired', 'The Claude login has expired. Run `claude` once in a terminal to refresh it.'), planName };
    }

    let response: { status: number; body: unknown };
    try {
      response = await dependencies.fetchJson(CLAUDE_USAGE_URL, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20',
          Accept: 'application/json',
        },
        timeoutMs: CLAUDE_USAGE_TIMEOUT_MS,
      });
    } catch {
      return { ...emptyResult('claude', 'error', 'Could not reach the Claude usage service.'), planName };
    }

    if (response.status === 401 || response.status === 403) {
      return { ...emptyResult('claude', 'token-expired', 'The Claude login was rejected. Run `claude` once in a terminal to refresh it.'), planName };
    }
    if (response.status < 200 || response.status >= 300) {
      return {
        ...emptyResult('claude', 'error', `The Claude usage service returned HTTP ${response.status}.`),
        planName,
      };
    }

    const windows = parseClaudeUsageBody(response.body);
    if (windows.length === 0) {
      return { ...emptyResult('claude', 'unsupported', 'The Claude usage service returned no limits for this account.'), planName };
    }

    return {
      provider: 'claude',
      status: 'ok',
      planName,
      windows,
      credits: null,
      source: 'live',
      fetchedAt: new Date(dependencies.now()).toISOString(),
    };
  }

  async function getClaudePlanUsage(): Promise<PlanUsageResult> {
    if (claudeCache && claudeCache.expiresAt > dependencies.now()) {
      return claudeCache.result;
    }
    // Concurrent opens share one upstream request.
    claudeInFlight ??= fetchClaudeUsage()
      .then((result) => {
        // Failures are not cached for the full window, but a short hold stops hammering a 429.
        claudeCache = {
          result,
          expiresAt: dependencies.now() + (result.status === 'ok' ? CLAUDE_USAGE_CACHE_MS : 10_000),
        };
        return result;
      })
      .finally(() => {
        claudeInFlight = null;
      });
    return claudeInFlight;
  }

  /** Session files newest-first by mtime, walking the date-partitioned tree. */
  async function listCodexSessionFiles(directoryPath: string): Promise<Array<{ file: string; mtimeMs: number }>> {
    let entries: Dirent[];
    try {
      entries = await dependencies.readDirectory(directoryPath);
    } catch {
      return [];
    }

    const files: Array<{ file: string; mtimeMs: number }> = [];
    for (const entry of entries) {
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        files.push(...await listCodexSessionFiles(entryPath));
      } else if (entry.name.endsWith('.jsonl')) {
        try {
          files.push({ file: entryPath, mtimeMs: await dependencies.statMtimeMs(entryPath) });
        } catch {
          // The file vanished between listing and stat.
        }
      }
    }
    return files;
  }

  async function getCodexPlanUsage(): Promise<PlanUsageResult> {
    const sessionsRoot = path.join(dependencies.getHomeDirectory(), '.codex', 'sessions');
    const files = (await listCodexSessionFiles(sessionsRoot))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, CODEX_MAX_FILES_SCANNED);

    if (files.length === 0) {
      return emptyResult('codex', 'unsupported', 'No Codex session has recorded usage limits yet.');
    }

    for (const { file } of files) {
      let tail: FileTail;
      try {
        tail = await dependencies.readTextFileTail(file, CODEX_LOG_TAIL_BYTES);
      } catch {
        continue;
      }

      const lines = tail.content.split('\n');
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (!lines[index].includes('"rate_limits"')) {
          continue;
        }
        try {
          const entry = JSON.parse(lines[index]) as AnyRecord;
          const rateLimits = entry.payload?.rate_limits;
          if (entry.payload?.type === 'token_count' && rateLimits && typeof rateLimits === 'object') {
            const result = parseCodexRateLimits(
              rateLimits as AnyRecord,
              toIsoFromDateLike(entry.timestamp),
              dependencies.now(),
            );
            if (result.windows.length > 0) {
              return result;
            }
          }
        } catch {
          // The last line may still be mid-write.
        }
      }
    }

    return emptyResult('codex', 'unsupported', 'No Codex session has recorded usage limits yet.');
  }

  return {
    async getPlanUsage(provider: string): Promise<PlanUsageResult> {
      if (provider === 'claude') {
        return getClaudePlanUsage();
      }
      if (provider === 'codex') {
        return getCodexPlanUsage();
      }
      if (provider === 'cursor' || provider === 'opencode') {
        return emptyResult(provider, 'unsupported', 'Plan usage is not available for this provider.');
      }
      throw new AppError(`Unsupported provider "${provider}".`, {
        code: 'UNSUPPORTED_PROVIDER',
        statusCode: 400,
      });
    },
  };
}

export const providerPlanUsageService = createProviderPlanUsageService();
