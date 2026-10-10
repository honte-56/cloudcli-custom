import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import readline from 'node:readline';

import type { AnyRecord } from '@/shared/types.js';

type PendingCall = {
  resolve: (result: AnyRecord) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** Used by Codex's live runtime to own one app-server connection per active run. */
export class CodexLiveClient {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<number, PendingCall>();
  private nextId = 1;
  private closed = false;
  private stderr = '';
  private reader: readline.Interface;

  constructor(
    private onNotification: (method: string, params: AnyRecord) => void,
    private onFailure: (error: Error) => void,
    launcher?: string,
  ) {
    const pathOverride = !launcher ? process.env.CLOUDCLI_CODEX_PATH?.trim() : undefined;
    this.child = spawn(pathOverride || process.execPath, pathOverride
      ? ['app-server']
      : [launcher || createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js'), 'app-server'],
    { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    this.reader = readline.createInterface({ input: this.child.stdout });
    this.child.stderr.on('data', (chunk) => { this.stderr = (this.stderr + String(chunk)).slice(-2000); });
    this.child.on('error', (error) => this.fail(error));
    this.child.stdin.on('error', (error) => this.fail(error));
    this.child.on('exit', (code) => this.fail(new Error(`Codex app-server exited (${code}): ${this.stderr}`)));
    this.reader.on('line', (line) => {
      let message: AnyRecord;
      try { message = JSON.parse(line); } catch { return; }
      // Server requests must be answered, never silently granted. Interactive
      // approvals are not exposed by the existing exec adapter either.
      if (message.method && message.id !== undefined) {
        const result = message.method.endsWith('/requestApproval') ? { decision: 'decline' } : null;
        this.write(result ? { id: message.id, result } : {
          id: message.id, error: { code: -32601, message: 'CloudCLI does not support this interactive request.' },
        });
      } else if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message || 'Codex request failed'));
        else pending.resolve(message.result || {});
      } else if (message.method) {
        try { this.onNotification(message.method, message.params || {}); }
        catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
      }
    });
  }

  private write(message: AnyRecord): void {
    if (this.closed) throw new Error('Codex app-server connection is closed.');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async initialize(): Promise<void> {
    await this.call('initialize', { clientInfo: { name: 'cloudcli', title: 'CloudCLI', version: '1.37.3' } });
    this.write({ method: 'initialized', params: {} });
  }

  call(method: string, params: AnyRecord): Promise<AnyRecord> {
    if (this.closed) return Promise.reject(new Error('Codex app-server connection is closed.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A lost steer response has an unknown outcome. Never retry it or
        // restart a turn automatically, since that could execute it twice.
        this.fail(new Error(`Codex ${method} timed out; delivery could not be confirmed.`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.close(error);
    this.onFailure(error);
  }

  close(error = new Error('Codex app-server connection closed.')): void {
    if (this.closed) return;
    this.closed = true;
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    this.pending.clear();
    this.reader.close();
    this.child.kill();
  }
}
