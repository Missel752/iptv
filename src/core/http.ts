/** HTTP client with timeouts, retries, conditional requests and an on-disk cache. */

import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { readJson, writeJson, readBuffer, writeBuffer, exists } from './fs.js';
import { retry } from './concurrency.js';
import { Logger } from './logger.js';

const log = new Logger('http');

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 IPTVNexus/1.0';

export interface FetchOptions {
  timeoutMs?: number;
  attempts?: number;
  headers?: Record<string, string>;
  userAgent?: string | null;
  referrer?: string | null;
  /** Cache directory; when set, responses are stored and revalidated with ETag. */
  cacheDir?: string | null;
  /** Serve from cache without revalidating if the entry is younger than this. */
  cacheTtlMs?: number;
  signal?: AbortSignal;
  method?: 'GET' | 'HEAD';
  /** Accept non-2xx responses instead of throwing. */
  allowErrorStatus?: boolean;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

interface CacheMeta {
  url: string;
  etag: string | null;
  last_modified: string | null;
  status: number;
  stored_at: number;
  content_type: string | null;
}

export interface HttpResponse {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  fromCache: boolean;
}

function cacheKey(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 40);
}

function buildHeaders(options: FetchOptions): Record<string, string> {
  const headers: Record<string, string> = {
    'accept-encoding': 'gzip, deflate',
    ...options.headers,
  };
  const ua = options.userAgent === null ? null : (options.userAgent ?? DEFAULT_USER_AGENT);
  if (ua) headers['user-agent'] = ua;
  if (options.referrer) {
    headers['referer'] = options.referrer;
    try {
      headers['origin'] = new URL(options.referrer).origin;
    } catch {
      /* referrer may not be a full URL */
    }
  }
  return headers;
}

/** Fetches a URL as a Buffer, honouring retries, timeouts and the disk cache. */
export async function httpGet(url: string, options: FetchOptions = {}): Promise<HttpResponse> {
  const {
    timeoutMs = 30_000,
    attempts = 3,
    cacheDir = null,
    cacheTtlMs = 0,
    method = 'GET',
  } = options;

  const key = cacheKey(url);
  const metaPath = cacheDir ? `${cacheDir}/${key}.meta.json` : null;
  const bodyPath = cacheDir ? `${cacheDir}/${key}.bin` : null;

  let meta: CacheMeta | null = null;
  if (metaPath && (await exists(metaPath))) {
    meta = await readJson<CacheMeta>(metaPath).catch(() => null);
    if (meta && cacheTtlMs > 0 && Date.now() - meta.stored_at < cacheTtlMs && bodyPath) {
      const cached = await readBuffer(bodyPath).catch(() => null);
      if (cached) {
        log.debug(`cache hit ${url}`);
        return {
          url,
          status: meta.status,
          headers: { 'content-type': meta.content_type ?? '' },
          body: cached,
          fromCache: true,
        };
      }
    }
  }

  const headers = buildHeaders(options);
  if (meta?.etag) headers['if-none-match'] = meta.etag;
  if (meta?.last_modified) headers['if-modified-since'] = meta.last_modified;

  const response = await retry(
    async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
      const onExternalAbort = (): void => controller.abort(options.signal?.reason);
      options.signal?.addEventListener('abort', onExternalAbort, { once: true });
      try {
        const res = await fetch(url, {
          method,
          headers,
          signal: controller.signal,
          redirect: 'follow',
        });
        if (res.status >= 500 && !options.allowErrorStatus) {
          throw new HttpError(`HTTP ${res.status} for ${url}`, res.status, url);
        }
        return res;
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onExternalAbort);
      }
    },
    {
      attempts,
      shouldRetry: (error) => !(error instanceof HttpError && error.status < 500),
      onRetry: (error, attempt, delay) =>
        log.debug(`retry ${attempt} in ${delay}ms — ${url} (${String(error)})`),
    },
  );

  // 304: the cached copy is still valid.
  if (response.status === 304 && bodyPath && meta) {
    const cached = await readBuffer(bodyPath).catch(() => null);
    if (cached) {
      meta.stored_at = Date.now();
      if (metaPath) await writeJson(metaPath, meta);
      log.debug(`not modified ${url}`);
      return {
        url,
        status: meta.status,
        headers: { 'content-type': meta.content_type ?? '' },
        body: cached,
        fromCache: true,
      };
    }
  }

  if (!response.ok && !options.allowErrorStatus) {
    throw new HttpError(`HTTP ${response.status} for ${url}`, response.status, url);
  }

  let body = Buffer.from(await response.arrayBuffer());
  // Some servers send gzip without a content-encoding header.
  if (body.length > 2 && body[0] === 0x1f && body[1] === 0x8b) {
    try {
      body = gunzipSync(body);
    } catch {
      /* not actually gzip */
    }
  }

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    responseHeaders[name] = value;
  });

  if (cacheDir && metaPath && bodyPath && response.ok) {
    await writeBuffer(bodyPath, body);
    await writeJson<CacheMeta>(metaPath, {
      url,
      etag: response.headers.get('etag'),
      last_modified: response.headers.get('last-modified'),
      status: response.status,
      stored_at: Date.now(),
      content_type: response.headers.get('content-type'),
    });
  }

  return {
    url: response.url || url,
    status: response.status,
    headers: responseHeaders,
    body,
    fromCache: false,
  };
}

export async function httpGetText(url: string, options: FetchOptions = {}): Promise<string> {
  const response = await httpGet(url, options);
  return response.body.toString('utf8');
}

export async function httpGetJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const text = await httpGetText(url, options);
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`Invalid JSON from ${url}: ${(error as Error).message}`);
  }
}

/** Normalises a stream URL into a stable dedupe key. */
export function streamKey(url: string): string {
  let normalized = url.trim();
  try {
    const parsed = new URL(normalized);
    parsed.hash = '';
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.protocol = parsed.protocol.toLowerCase();
    if (
      (parsed.protocol === 'http:' && parsed.port === '80') ||
      (parsed.protocol === 'https:' && parsed.port === '443')
    ) {
      parsed.port = '';
    }
    // Session tokens make identical streams look distinct.
    const volatile = ['token', 'auth', 'sig', 'signature', 'expires', 'expire', 'hdnts', 'wmsauthsign', 'session', 'sid', '_t', 't'];
    for (const param of volatile) parsed.searchParams.delete(param);
    parsed.search = parsed.searchParams.toString();
    if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    // Treat http/https as the same resource for dedupe purposes.
    normalized = `${parsed.host}${parsed.pathname}${parsed.search}`;
  } catch {
    normalized = normalized.toLowerCase();
  }
  return createHash('sha1').update(normalized).digest('hex').slice(0, 16);
}

/** True when the URL looks like a playable stream we know how to handle. */
export function isPlayableUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url) && !/^rtmps?:\/\//i.test(url) && !/^rtsp:\/\//i.test(url)) {
    return false;
  }
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes('.') && parsed.hostname !== 'localhost') return false;
    if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(parsed.hostname)) return false;
    if (parsed.hostname === 'localhost') return false;
    return true;
  } catch {
    return false;
  }
}
