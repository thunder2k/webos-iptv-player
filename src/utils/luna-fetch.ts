/**
 * Fetch() fallback for webOS 3.9 where neither fetch nor XMLHttpRequest exist.
 * Uses the bundled webOS JS service (com.lennylxx.iptv.service) as an HTTP
 * client: the app sends a `fetch_url` Luna request, the service's Node.js
 * http/https client fetches the URL, and the body comes back as text.
 *
 * Falls into place behind src/utils/fetch-helper.ts, which checks
 * `typeof fetch === 'undefined'` at call time and routes through here.
 */

import { isLunaAvailable, lunaRequest } from '../services/luna';
import { CONFIG } from '../config';

const FETCH_TIMEOUT = 60000;

export interface LunaFetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  body: string | null;
  error?: string;
}

/**
 * A minimal fetch-compatible Response built from a Luna fetch_url result.
 * Only the members used by fetch-helper.ts and m3u-loader.ts are implemented:
 * ok, status, statusText, headers.get(), body.getReader(), text(), arrayBuffer().
 */
export class LunaResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly headers: { get: (name: string) => string | null };
  private readonly _body: string;

  constructor(result: LunaFetchResponse) {
    this.ok = result.ok;
    this.status = result.status;
    this.statusText = result.statusText;
    const len = result.body ? result.body.length : 0;
    this.headers = {
      get: (name: string): string | null => {
        const l = String(name).toLowerCase();
        if (l === 'content-length') return String(len);
        if (l === 'content-type') return 'text/plain; charset=utf-8';
        return null;
      },
    };
    this._body = result.body ?? '';
  }

  async text(): Promise<string> {
    return this._body;
  }

  async arrayBuffer(): Promise<Uint8Array> {
    const bytes = new Uint8Array(this._body.length);
    for (let i = 0; i < this._body.length; i++) {
      bytes[i] = this._body.charCodeAt(i);
    }
    return bytes;
  }

  get body(): { getReader: () => { read: () => Promise<{ done: boolean; value?: Uint8Array }>; cancel: () => Promise<void> } } | null {
    if (!this._body) return null;
    const encoder = new TextEncoder();
    const bytes = encoder.encode(this._body);
    let offset = 0;
    return {
      getReader: () => ({
        read: (): Promise<{ done: boolean; value?: Uint8Array }> => {
          if (offset >= bytes.length) {
            return Promise.resolve({ done: true });
          }
          const end = Math.min(offset + 8192, bytes.length);
          const chunk = bytes.subarray(offset, end);
          offset = end;
          return Promise.resolve({ done: false, value: chunk });
        },
        cancel: (): Promise<void> => Promise.resolve(),
      }),
    };
  }
}

/**
 * Fetch a URL via the bundled service's Luna `fetch_url` method. Returns a
 * fetch-compatible Response-like object, or rejects on error/timeout.
 */
export async function fetchViaLuna(url: string, timeout = FETCH_TIMEOUT): Promise<LunaResponse> {
  if (!isLunaAvailable()) {
    throw new Error('Luna not available — cannot fetch via bundled service');
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`Luna fetch timed out after ${timeout}ms`));
      }
    }, timeout);

    const finish = (result: LunaFetchResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(new LunaResponse(result));
    };

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    try {
      lunaRequest(`luna://${CONFIG.SERVICE_ID}`, {
        method: 'fetch_url',
        parameters: { url },
        onSuccess: (resp: unknown) => {
          const r = resp as LunaFetchResponse | undefined;
          if (!r || typeof r !== 'object') {
            fail(new Error('Invalid Luna fetch response'));
            return;
          }
          if (r.ok && r.body !== null && r.body !== undefined) {
            finish(r);
          } else {
            finish({
              ok: false,
              status: r.status ?? 0,
              statusText: r.statusText ?? '',
              body: r.body ?? null,
              error: r.error || `HTTP ${r.status ?? 0}: ${r.statusText ?? ''}`,
            });
          }
        },
        onFailure: (err: unknown) => {
          fail(err);
        },
      });
    } catch (e) {
      fail(e);
    }
  });
}

/**
 * Fetch a URL via Luna and return the body text directly. Throws on non-ok
 * responses, matching the fetchText contract.
 */
export async function fetchViaLunaText(url: string, timeout = FETCH_TIMEOUT): Promise<string> {
  const response = await fetchViaLuna(url, timeout);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  return response.text();
}

export function isLunaFetchAvailable(): boolean {
  return isLunaAvailable();
}
