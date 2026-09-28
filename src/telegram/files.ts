// telegram/files.ts (WP2) — the ONLY module that ever sees a Telegram file URL (01 §4.2 coding rules). The URL contains the
// bot token, so it is never logged, returned or stored. Downloads are capped at `maxBytes` (cloud Bot API limit 20 MB)
// both by the declared size and while reading the body.
import type { Api } from 'grammy';
import type { Clock, Logger, TelegramFiles } from '../contracts/index.ts';

export class FileTooLargeError extends Error {
  override name = 'FileTooLargeError';
}

export function createTelegramFiles(d: { api: () => Api; token: string; apiRoot: string; testEnv: boolean; fetchImpl: typeof fetch; clock: Clock; log: Logger; timeoutMs?: number }): TelegramFiles {
  const timeoutMs = d.timeoutMs ?? 60_000;
  return {
    async download(fileId, maxBytes) {
      const f = await d.api().getFile(fileId);
      if (typeof f.file_size === 'number' && f.file_size > maxBytes) throw new FileTooLargeError(`file is ${f.file_size} bytes (limit ${maxBytes})`);
      if (!f.file_path) throw new Error('Telegram returned no file_path (file too big for the Bot API?)');
      const url = `${d.apiRoot}/file/bot${d.token}${d.testEnv ? '/test' : ''}/${f.file_path}`;
      const ctl = new AbortController();
      const h = d.clock.setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await d.fetchImpl(url, { signal: ctl.signal });
        if (!res.ok) throw new Error(`file download failed with HTTP ${res.status}`);
        const declared = Number(res.headers.get('content-length') ?? NaN);
        if (Number.isFinite(declared) && declared > maxBytes) throw new FileTooLargeError(`file is ${declared} bytes (limit ${maxBytes})`);
        const bytes = await readCapped(res, maxBytes);
        const ext = (/\.([A-Za-z0-9]{1,8})$/.exec(f.file_path)?.[1] ?? '').toLowerCase();
        return { bytes, size: bytes.length, ext };
      } catch (e) {
        // never include the URL (it carries the token)
        if (e instanceof FileTooLargeError) throw e;
        d.log.warn({ err: e instanceof Error ? e.name : 'error' }, 'telegram file download failed');
        throw new Error(`file download failed (${e instanceof Error ? e.name : 'error'})`);
      } finally {
        d.clock.clearTimeout(h);
      }
    },
  };
}

async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  if (!res.body) {
    const b = new Uint8Array(await res.arrayBuffer());
    if (b.length > maxBytes) throw new FileTooLargeError(`file exceeds ${maxBytes} bytes`);
    return b;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new FileTooLargeError(`file exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
