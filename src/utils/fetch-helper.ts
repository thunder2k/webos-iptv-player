import { gunzipSync } from 'fflate';
import { fetchViaLuna, fetchViaLunaText } from './luna-fetch';

// On webOS 3.9 / Chromium 38, `fetch` may exist as a function but throw
// "undefined is not a function" when called. AbortSignal.prototype.addEventListener
// is undefined on this platform, which is a reliable indicator of Chromium 38.
// When fetch is broken, route through fetchViaLuna (bundled service via Luna).
/* eslint-disable compat/compat */
export const supportsFetch =
  typeof fetch !== 'undefined' &&
  typeof AbortSignal !== 'undefined' &&
  typeof AbortSignal.prototype.addEventListener === 'function';
/* eslint-enable compat/compat */

export type FetchTextErrorCode =
  | 'aborted'
  | 'timeout'
  | 'too_large'
  | 'http'
  | 'invalid_content';

export class FetchTextError extends Error {
  constructor(
    public readonly code: FetchTextErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FetchTextError';
  }
}

export type FetchPrefixVerdict = 'match' | 'mismatch' | 'undecided';
export type FetchPrefixValidator = (
  bytes: Uint8Array,
  complete: boolean,
) => FetchPrefixVerdict;

export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeout = 30000
): Promise<Response> {
  if (!supportsFetch) {
    // webOS 3.9 has no fetch or XMLHttpRequest — route through the bundled
    // service's Node.js HTTP client via Luna.
    return fetchViaLuna(url, timeout) as unknown as Response;
  }
  const controller = createAbortController();
  const timer = setTimeout(() => controller?.abort(), timeout);

  let response: Response;
  try {
    response = await fetch(url, withAbortSignal(options, controller));
  } catch {
    // Chromium 38 does not support the `signal` option on fetch(); retry without it
    response = await fetch(url, options);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  return response;
}

export async function fetchText(url: string, timeout = 30000): Promise<string> {
  if (!supportsFetch) {
    return fetchViaLunaText(url, timeout);
  }
  const controller = createAbortController();
  const timer = setTimeout(() => controller?.abort(), timeout);

  let response: Response;
  try {
    response = await fetch(url, withAbortSignal({}, controller));
  } catch {
    // Chromium 38 does not support the `signal` option on fetch(); retry without it
    response = await fetch(url);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  return await response.text();
}


function createAbortController(): AbortController | null {
  return typeof AbortController === 'function' ? new AbortController() : null;
}

function withAbortSignal(options: RequestInit, controller: AbortController | null): RequestInit {
  return controller ? { ...options, signal: controller.signal } : options;
}

const UTF8_BOM = [0xef, 0xbb, 0xbf];

// Longest run of bytes that could still be leading BOM without being one yet.
function bomLength(bytes: readonly number[]): number {
  for (let i = 0; i < UTF8_BOM.length; i++) {
    if (i >= bytes.length) return -1; // undecided — need more bytes
    if (bytes[i] !== UTF8_BOM[i]) return 0;
  }
  return UTF8_BOM.length;
}

// Compare bytes against ASCII candidate prefixes after an optional UTF-8 BOM;
// byte-wise matching keeps prefix checks independent of text decoding.
function matchPrefixes(bytes: readonly number[], prefixes: readonly string[]): FetchPrefixVerdict {
  const bom = bomLength(bytes);
  if (bom < 0) return 'undecided';
  const body = bytes.slice(bom);
  let undecided = false;
  for (const prefix of prefixes) {
    let ok = true;
    for (let i = 0; i < prefix.length; i++) {
      if (i >= body.length) { undecided = true; ok = false; break; }
      if (body[i] !== prefix.charCodeAt(i)) { ok = false; break; }
    }
    if (ok) return 'match';
  }
  return undecided ? 'undecided' : 'mismatch';
}

export async function fetchLimitedText(
  url: string,
  maxBytes: number,
  timeout: number,
  signal?: AbortSignal,
  requiredPrefix?: string | readonly string[] | FetchPrefixValidator,
): Promise<string> {
  if (!supportsFetch) {
    // webOS 3.9 has no fetch — route through the bundled service via Luna.
    // No streaming/abort is possible, so fetch the full text then validate.
    const text = await fetchViaLunaText(url, timeout);
    if (text.length > maxBytes) {
      throw new FetchTextError('too_large', `Response exceeds ${maxBytes} bytes`);
    }
    const validator = typeof requiredPrefix === 'function' ? requiredPrefix : null;
    const prefixes: readonly string[] = typeof requiredPrefix === 'string'
      ? [requiredPrefix]
      : requiredPrefix === undefined || typeof requiredPrefix === 'function'
        ? []
        : requiredPrefix;
    if (validator || prefixes.length > 0) {
      const encoder = new TextEncoder();
      const bytes = encoder.encode(text);
      const verdict = validator
        ? validator(bytes, true)
        : matchPrefixes(Array.from(bytes), prefixes);
      if (verdict !== 'match') throw new FetchTextError(
        'invalid_content',
        validator ? 'Response has an invalid opening'
          : `Response does not begin with ${prefixes.join(' or ')}`,
      );
    }
    return text;
  }

  const controller = createAbortController();
  let timedOut = false;
  const abort = () => controller?.abort();
  const onTimeout = () => {
    timedOut = true;
    controller?.abort();
  };
  const timer = setTimeout(onTimeout, timeout);
  if (signal?.aborted) abort();
  else signal?.addEventListener?.('abort', abort);

  const validator = typeof requiredPrefix === 'function' ? requiredPrefix : null;
  const prefixes: readonly string[] = typeof requiredPrefix === 'string'
    ? [requiredPrefix]
    : requiredPrefix === undefined || typeof requiredPrefix === 'function'
      ? []
      : requiredPrefix;
  const prefixError = () => new FetchTextError(
    'invalid_content',
    validator
      ? 'Response has an invalid opening'
      : `Response does not begin with ${prefixes.join(' or ')}`,
  );
  const hasPrefixCheck = !!validator || prefixes.length > 0;
  const prefixProbeLength = validator
    ? 8192
    : prefixes.reduce((n, p) => Math.max(n, p.length), 0) + UTF8_BOM.length;
  const checkPrefix = (bytes: Uint8Array, complete: boolean): FetchPrefixVerdict =>
    validator
      ? validator(bytes, complete)
      : matchPrefixes(Array.from(bytes), prefixes);

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let complete = false;
  let response: Response;
  let firstFetchError: unknown;
  try {
    response = await fetch(url, withAbortSignal({}, controller));
  } catch (firstErr) {
    firstFetchError = firstErr;
    // Chromium 38 does not support the `signal` option on fetch(); retry without it
    try {
      response = await fetch(url);
    } catch (retryErr) {
      if (typeof window !== 'undefined') (window as any).__debugFetchRetryError = String(retryErr);
      if (typeof window !== 'undefined') (window as any).__debugFetchFirstError = String(firstFetchError);
      throw retryErr;
    }
  }
  if (!response.ok) {
    throw new FetchTextError('http', `HTTP ${response.status}: ${response.statusText}`);
  }
  const declaredLength = Number(response.headers?.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new FetchTextError('too_large', `Response exceeds ${maxBytes} bytes`);
  }
  try {
    reader = typeof response.body?.getReader === 'function'
      ? response.body.getReader()
      : null;
    if (!reader) {
      // Non-streaming fallback (Chromium 38 has no ReadableStream). Load the
      // full response, then validate size and prefix.
      const fullText = await response.text();
      if (fullText.length > maxBytes) {
        throw new FetchTextError('too_large', `Response exceeds ${maxBytes} bytes`);
      }
      if (hasPrefixCheck && !validator) {
        let matched = false;
        for (const prefix of prefixes) {
          if (fullText.startsWith(prefix)) { matched = true; break; }
        }
        if (!matched) throw prefixError();
      }
      return fullText;
    }

    const chunks: Uint8Array[] = [];
    let length = 0;
    const head: number[] = [];
    let prefixSettled = !hasPrefixCheck;
    while (true) {
      const { done, value } = await reader.read();
      if (done) { complete = true; break; }
      if (!value?.length) continue;
      length += value.length;
      if (length > maxBytes) {
        throw new FetchTextError('too_large', `Response exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
      if (!prefixSettled) {
        for (let i = 0; i < value.length && head.length < prefixProbeLength; i++) {
          head.push(value[i]);
        }
        const verdict = checkPrefix(new Uint8Array(head), false);
        if (verdict === 'mismatch') throw prefixError();
        if (verdict === 'match') prefixSettled = true;
        if (verdict === 'undecided' && head.length === prefixProbeLength) {
          throw prefixError();
        }
      }
    }
    if (!prefixSettled
        && checkPrefix(new Uint8Array(head), true) !== 'match') throw prefixError();

    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return new TextDecoder().decode(bytes);
  } catch (err) {
    if (err instanceof FetchTextError) throw err;
    if (signal?.aborted) throw new FetchTextError('aborted', 'Request was cancelled');
    if (timedOut) throw new FetchTextError('timeout', 'Request timed out');
    throw err;
  } finally {
    if (reader && !complete) void reader.cancel().catch(() => {});
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', abort);
  }
}

export async function fetchMaybeGzipText(url: string, timeout = 30000): Promise<string> {
  if (!supportsFetch) {
    return fetchViaLunaText(url, timeout);
  }
  const response = await fetchWithTimeout(url, {}, timeout);
  let bytes = new Uint8Array(await response.arrayBuffer());

  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    bytes = gunzipSync(bytes);
  }

  return new TextDecoder().decode(bytes);
}

export async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  retries = 2,
  timeout = 30000
): Promise<Response> {
  if (typeof fetch === 'undefined') {
    return fetchViaLuna(url, timeout) as unknown as Response;
  }
  let lastError: Error | undefined;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fetchWithTimeout(url, options, timeout);
    } catch (err) {
      lastError = err as Error;
      if (i < retries) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)));
      }
    }
  }
  throw lastError;
}
