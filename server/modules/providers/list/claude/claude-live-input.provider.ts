import { randomUUID } from 'node:crypto';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

/** Used by Claude's runtime to keep one CLI input stream open and confirm receipt before consuming text at a safe boundary. */
export function createClaudeInputStream(initial: SDKUserMessage[], acknowledgementMs = 30_000) {
  const queue = [...initial];
  const pending = new Map<string, { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  // Retain sent ids after acknowledgement so duplicate echoes never become chat rows.
  const sentIds = new Set<string>();
  const awaitingConsumption = new Set<string>();
  let closed = false;
  let wake: (() => void) | undefined;

  const stream = (async function* () {
    while (!closed) {
      const message = queue.shift();
      if (message) yield message;
      else await new Promise<void>((resolve) => { wake = resolve; });
    }
  })();

  return {
    stream,
    get open() { return !closed; },
    get pending() { return awaitingConsumption.size > 0; },
    send(content: string): Promise<void> {
      if (closed) return Promise.reject(new Error('Claude is no longer accepting live input.'));
      const uuid = randomUUID();
      const receipt = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(uuid);
          reject(new Error('Claude has not acknowledged this message. Delivery is uncertain; check the conversation before retrying.'));
        }, acknowledgementMs);
        timer.unref?.();
        pending.set(uuid, { resolve, reject, timer });
      });
      sentIds.add(uuid);
      awaitingConsumption.add(uuid);
      queue.push({ type: 'user', uuid, message: { role: 'user', content }, parent_tool_use_id: null,
        // Deliver at the next safe boundary; never interrupt a running tool.
        priority: 'next', timestamp: new Date().toISOString() });
      wake?.();
      wake = undefined;
      return receipt;
    },
    acknowledge(message: { type: string; uuid?: string; command_uuid?: string; state?: string; parent_tool_use_id?: string | null }): boolean {
      const lifecycle = message.type === 'command_lifecycle';
      const uuid = lifecycle ? message.command_uuid : message.uuid;
      if ((!lifecycle && message.type !== 'user') || message.parent_tool_use_id || !uuid || !sentIds.has(uuid)) return false;
      // queued is a CLI receipt, not proof that the model has read the text.
      // Keep stdin alive across older results until the user's replay arrives.
      if (!lifecycle || message.state === 'cancelled') awaitingConsumption.delete(uuid);
      const receipt = pending.get(uuid);
      if (receipt) {
        if (lifecycle && !['queued', 'started', 'cancelled'].includes(message.state ?? '')) return true;
        clearTimeout(receipt.timer);
        pending.delete(uuid);
        if (message.state === 'cancelled') receipt.reject(new Error('Claude cancelled the live message before delivery.'));
        else receipt.resolve();
      }
      return true;
    },
    release() {
      closed = true;
      queue.length = 0;
      for (const receipt of pending.values()) {
        clearTimeout(receipt.timer);
        receipt.reject(new Error('Claude stopped before acknowledging this message. Delivery is uncertain.'));
      }
      pending.clear();
      awaitingConsumption.clear();
      wake?.();
      wake = undefined;
    },
  };
}
