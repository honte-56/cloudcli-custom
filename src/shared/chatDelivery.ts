type Socket = { readyState: number; send(data: string): void; close(): void };

/** Used by WebSocketContext to confirm chat admission and safely retry the same request after reconnecting. */
export function createChatDelivery(getSocket: () => Socket | null, getOwner: () => string) {
  const pending = new Map<string, {
    serialized: string; storageKey: string; resolve(): void; reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>; retry: ReturnType<typeof setInterval>;
  }>();
  const remembered = new Map<string, string>();
  const transmit = (serialized: string) => {
    const socket = getSocket();
    if (socket?.readyState === 1) socket.send(serialized);
  };
  const read = (key: string): Array<{ payload: string; requestId: string; message: Record<string, unknown> }> => {
    let saved = remembered.get(key);
    try { saved ??= sessionStorage.getItem(key) ?? undefined; } catch { /* Optional persistence. */ }
    try {
      const parsed = JSON.parse(saved ?? '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  };
  const write = (key: string, records: Array<{ payload: string; requestId: string; message: Record<string, unknown> }>) => {
    if (!records.length) {
      remembered.delete(key);
      try { sessionStorage.removeItem(key); } catch { /* Optional persistence. */ }
    } else {
      const saved = JSON.stringify(records);
      remembered.set(key, saved);
      try { sessionStorage.setItem(key, saved); } catch { /* Keep the in-memory copy. */ }
    }
  };
  return {
    send(message: Record<string, unknown>): Promise<void> {
      if (getSocket()?.readyState !== 1) {
        return Promise.reject(new Error('连接尚未恢复，消息未发送。输入已保留，请连接恢复后重试。'));
      }
      const storageKey = `cloudcli-send:${getOwner()}:${message.sessionId}`;
      // The sidebar may rename a session while confirmation is missing. That
      // display-only summary must not turn a retry into a second execution.
      const options = message.options as Record<string, unknown> | undefined;
      const payload = JSON.stringify({ ...message, ...(options ? { options: { ...options, sessionSummary: undefined } } : {}) });
      const records = read(storageKey);
      const previous = records.find((record) => record.payload === payload);
      const requestId = previous?.requestId ?? crypto.randomUUID();
      if (pending.has(requestId)) return Promise.reject(new Error('这条消息正在等待确认。'));
      if (!previous) write(storageKey, [...records, { payload, requestId, message }]);
      const serialized = JSON.stringify({ ...(previous?.message ?? message), requestId });
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          const entry = pending.get(requestId);
          if (!entry) return;
          clearInterval(entry.retry);
          pending.delete(requestId);
          // The socket may be half-open after a mobile device wakes up.
          getSocket()?.close();
          reject(new Error('尚未收到服务器确认，消息可能已送达。输入已保留；重试相同内容不会重复启动任务。'));
        }, 25_000);
        const retry = setInterval(() => {
          try { transmit(serialized); } catch { /* Reconnect or timeout will settle this send. */ }
        }, 3000);
        pending.set(requestId, { serialized, storageKey, resolve, reject, timer, retry });
        try { transmit(serialized); } catch {
          clearTimeout(timer); clearInterval(retry); pending.delete(requestId);
          reject(new Error('连接中断，输入已保留，请重试。'));
        }
      });
    },
    receive(event: Record<string, unknown>): boolean {
      if (event.kind !== 'chat_send_receipt') return false;
      const entry = pending.get(String(event.requestId));
      if (!entry || event.status === 'pending') return true;
      clearTimeout(entry.timer); clearInterval(entry.retry);
      pending.delete(String(event.requestId));
      if (event.status === 'accepted' || event.status === 'rejected') {
        write(entry.storageKey, read(entry.storageKey).filter(record => record.requestId !== event.requestId));
      }
      if (event.status === 'accepted') entry.resolve();
      else entry.reject(new Error(String(event.error || '消息接收未确认，输入已保留。')));
      return true;
    },
    reconnect() {
      for (const entry of pending.values()) {
        try { transmit(entry.serialized); } catch { /* Keep waiting for acknowledgement. */ }
      }
    },
    dispose() {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer); clearInterval(entry.retry);
        entry.reject(new Error('连接已更换，输入已保留。请重试。'));
      }
      pending.clear();
    },
  };
}
