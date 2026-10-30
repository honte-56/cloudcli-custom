import { afterEach, expect, test, vi } from 'vitest';

import { api } from '@/shared/api';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

test('chat uploads preserve browser multipart boundaries and authentication', async () => {
  localStorage.setItem('auth-token', 'test-token');
  const fetcher = vi.fn(async () => new Response('{}'));
  vi.stubGlobal('fetch', fetcher);
  const data = new FormData();
  data.append('files', new File(['hello'], 'notes.txt'));
  await api.assets.uploadFiles(data);
  const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('/api/assets/files');
  expect(options.body).toBe(data);
  expect(options.headers).toEqual({ Authorization: 'Bearer test-token' });
  expect(options.signal).toBeInstanceOf(AbortSignal);
});

test('an interrupted upload times out so the composer can retry', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn((_url, { signal }: RequestInit) => new Promise((_resolve, reject) => {
    signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  })));
  const upload = api.assets.uploadFiles(new FormData());
  const rejected = expect(upload).rejects.toThrow(/timed out/);
  await vi.advanceTimersByTimeAsync(120_000);
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});

test('a 22MB document uses bounded chunks and retains its upload identity on retry', async () => {
  const file = new File([new Uint8Array(22 * 1024 * 1024)], 'document.docx');
  const data = new FormData(); data.append('files', file);
  const calls: FormData[] = [];
  let fail = true;
  vi.stubGlobal('fetch', vi.fn(async (url: string, { body }: RequestInit) => {
    expect(url).toBe('/api/assets/files/chunks');
    const chunk = body as FormData;
    calls.push(chunk);
    expect((chunk.get('chunk') as Blob).size).toBeLessThanOrEqual(8 * 1024 * 1024);
    if (chunk.get('index') === '1' && fail) { fail = false; throw new Error('offline'); }
    return new Response(JSON.stringify(chunk.get('index') === '2'
      ? { attachments: [{ name: file.name, size: file.size, path: '/assets/doc.docx' }] }
      : { pending: true }));
  }));
  await expect(api.assets.uploadFiles(data)).rejects.toThrow(/connection/);
  const response = await api.assets.uploadFiles(data);
  expect((await response.json()).attachments[0].size).toBe(file.size);
  expect(new Set(calls.map(chunk => chunk.get('uploadId'))).size).toBe(1);
  expect(calls.map(chunk => chunk.get('index'))).toEqual(['0', '1', '0', '1', '2']);
});

test('over 100MB fails clearly before issuing a request', async () => {
  const file = new File(['x'], 'too-large.docx');
  Object.defineProperty(file, 'size', { value: 101 * 1024 * 1024 });
  const data = new FormData(); data.append('files', file);
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  await expect(api.assets.uploadFiles(data)).rejects.toThrow(/100MB/);
  expect(fetcher).not.toHaveBeenCalled();
});
