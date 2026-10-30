import type { AnyRecord } from '@/shared/types.js';

/**
 * True for the CLI's own API-request bookkeeping rows (`api-request`,
 * `api-request-blob`, `api-request-shape`).
 *
 * Newer Claude Code versions write a content-addressed copy of each request
 * body into the session file. A `api-request-blob` row carries a bare
 * `message: { role: 'user', content: [...] }` with no uuid and no timestamp, so
 * anything that treats "has a user message" as "is a chat row" shows the same
 * prompt a second time (stamped with the time the file was read) along with
 * the CLI's injected system reminders.
 */
export function isClaudeApiRequestRow(row: AnyRecord): boolean {
  return typeof row.type === 'string' && row.type.startsWith('api-request');
}
