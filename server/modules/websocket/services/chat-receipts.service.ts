import { createHash } from 'node:crypto';
import type { WebSocket } from 'ws';
import { chatReceiptsDb } from '@/modules/database/index.js';
import type { AnyRecord } from '@/shared/types.js';

const admissions = new WeakMap<object, () => void>();
const pending = new Set<string>();

/** Used by chat dispatch once validation and any edit rewind have succeeded, before invoking the provider. */
export function acknowledgeChatSend(data: AnyRecord): void {
  admissions.get(data)?.();
}

/** Used by the chat gateway to admit each authenticated request at most once, including after a restart. */
export async function withChatReceipt(
  ws: WebSocket, userId: string | number | null, data: AnyRecord, dispatch: () => Promise<void>,
): Promise<void> {
  if (data.requestId === undefined) return dispatch(); // Existing clients remain compatible.
  const reply = (status: string, error?: string) => ({
    kind: 'chat_send_receipt', requestId: data.requestId, sessionId: data.sessionId, status, error,
  });
  const send = (response: unknown) => {
    // A disappearing socket must not cancel a durably accepted dispatch.
    try { if (ws.readyState === 1) ws.send(JSON.stringify(response)); } catch { /* Retry reads the stored receipt. */ }
  };
  if (typeof data.requestId !== 'string' || !/^[\w-]{16,100}$/.test(data.requestId)) {
    send(reply('rejected', 'Invalid message identifier.'));
    return;
  }
  const key = JSON.stringify([userId, data.sessionId, data.requestId]);
  const fingerprint = createHash('sha256').update(JSON.stringify({
    type: data.type, content: data.content, options: data.options, anchorId: data.anchorId,
  })).digest('hex');
  const claim = chatReceiptsDb.claim(key, fingerprint);
  if (!claim.inserted) {
    if (claim.fingerprint !== fingerprint) send(reply('rejected', 'Message identifier was reused with different content.'));
    else if (claim.response) send({ ...JSON.parse(claim.response), replayed: true });
    else send(reply(pending.has(key) ? 'pending' : 'uncertain', 'Server restarted before confirming this message. Check the conversation before sending again.'));
    return;
  }
  pending.add(key);
  let settled = false;
  const settle = (status: string, error?: string) => {
    if (settled) return;
    const response = reply(status, error);
    // Persist before acknowledgement or execution: retries cannot run it twice.
    chatReceiptsDb.settle(key, JSON.stringify(response));
    settled = true;
    send(response);
  };
  admissions.set(data, () => settle('accepted'));
  try {
    await dispatch();
    settle('rejected', 'Message was not accepted. Check the error above and retry; your draft has been kept.');
  } catch (error) {
    settle('rejected', error instanceof Error ? error.message : String(error));
  } finally {
    pending.delete(key);
    admissions.delete(data);
  }
}
