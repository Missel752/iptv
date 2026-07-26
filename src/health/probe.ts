/** Stream probing: HTTP manifest checks plus optional ffprobe media analysis. */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DEFAULT_USER_AGENT } from '../core/http.js';
import { qualityFromHeight } from '../core/text.js';
import { Logger } from '../core/logger.js';
import type { HealthCheck, StreamMedia, StreamStatus } from '../core/types.js';

const execFileAsync = promisify(execFile);
const log = new Logger('probe');

let ffprobeAvailable: boolean | null = null;

/** Detects ffprobe once per process. */
export async function hasFfprobe(): Promise<boolean> {
  if (ffprobeAvailable !== null) return ffprobeAvailable;
  try {
    await execFileAsync('ffprobe', ['-version'], { timeout: 5000 });
    ffprobeAvailable = true;
  } catch {
    ffprobeAvailable = false;
    log.warn('ffprobe not found — falling back to HTTP-only checks');
  }
  return ffprobeAvailable;
}

export interface ProbeOptions {
  timeoutMs: number;
  userAgent?: string | null;
  referrer?: string | null;
  useFfprobe: boolean;
  /** Seconds of stream ffprobe should analyse. */
  probeDuration: number;
}

function classifyError(error: unknown): { status: StreamStatus; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes('abort') || lower.includes('timeout') || lower.includes('timed out')) {
    return { status: 'timeout', message: 'timeout' };
  }
  if (lower.includes('403') || lower.includes('forbidden') || lower.includes('geo')) {
    return { status: 'blocked', message: 'forbidden' };
  }
  if (
    lower.includes('enotfound') ||
    lower.includes('econnrefused') ||
    lower.includes('econnreset') ||
    lower.includes('ehostunreach') ||
    lower.includes('fetch failed')
  ) {
    return { status: 'offline', message: message.slice(0, 120) };
  }
  if (lower.includes('certificate') || lower.includes('ssl') || lower.includes('tls')) {
    return { status: 'error', message: 'tls error' };
  }
  return { status: 'error', message: message.slice(0, 160) };
}

function statusFromHttp(code: number): StreamStatus {
  if (code >= 200 && code < 300) return 'online';
  if (code === 401 || code === 403 || code === 451) return 'blocked';
  if (code === 404 || code === 410) return 'offline';
  if (code === 429) return 'blocked';
  if (code >= 500) return 'offline';
  return 'error';
}

/** Counts variant streams and reads resolutions from an HLS master playlist. */
function parseMasterPlaylist(body: string): { variants: number; bestHeight: number | null; bestBandwidth: number | null } {
  const lines = body.split(/\r?\n/);
  let variants = 0;
  let bestHeight: number | null = null;
  let bestBandwidth: number | null = null;

  for (const line of lines) {
    if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
    variants++;
    const resolution = /RESOLUTION=(\d+)x(\d+)/i.exec(line);
    const height = resolution?.[2] ? Number.parseInt(resolution[2], 10) : null;
    if (height && (bestHeight === null || height > bestHeight)) bestHeight = height;
    const bandwidth = /(?:AVERAGE-)?BANDWIDTH=(\d+)/i.exec(line);
    const value = bandwidth?.[1] ? Number.parseInt(bandwidth[1], 10) : null;
    if (value && (bestBandwidth === null || value > bestBandwidth)) bestBandwidth = value;
  }
  return { variants, bestHeight, bestBandwidth };
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  bit_rate?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { bit_rate?: string; duration?: string };
}

function parseFrameRate(value: string | undefined): number | null {
  if (!value) return null;
  const [numerator, denominator] = value.split('/').map(Number);
  if (!numerator || !denominator) return null;
  const rate = numerator / denominator;
  return Number.isFinite(rate) && rate > 0 ? Math.round(rate * 100) / 100 : null;
}

/** Runs ffprobe against a stream URL and extracts media metadata. */
export async function ffprobeStream(
  url: string,
  options: ProbeOptions,
): Promise<StreamMedia | null> {
  const headers: string[] = [];
  if (options.userAgent !== null) {
    headers.push('-user_agent', options.userAgent ?? DEFAULT_USER_AGENT);
  }
  if (options.referrer) headers.push('-headers', `Referer: ${options.referrer}\r\n`);

  const args = [
    '-v', 'error',
    '-hide_banner',
    ...headers,
    '-rw_timeout', String(options.timeoutMs * 1000),
    '-analyzeduration', String(options.probeDuration * 1_000_000),
    '-probesize', String(Math.max(1_000_000, options.probeDuration * 1_500_000)),
    '-print_format', 'json',
    '-show_streams',
    '-show_format',
    '-i', url,
  ];

  try {
    const { stdout } = await execFileAsync('ffprobe', args, {
      timeout: options.timeoutMs + 5000,
      maxBuffer: 8 * 1024 * 1024,
      killSignal: 'SIGKILL',
    });
    const parsed = JSON.parse(stdout) as FfprobeOutput;
    const streams = parsed.streams ?? [];
    const video = streams.find((stream) => stream.codec_type === 'video');
    const audio = streams.find((stream) => stream.codec_type === 'audio');
    if (!video && !audio) return null;

    const height = video?.height ?? null;
    const bitrate =
      Number.parseInt(parsed.format?.bit_rate ?? video?.bit_rate ?? '', 10) || null;

    return {
      width: video?.width ?? null,
      height,
      resolution: qualityFromHeight(height),
      frame_rate: parseFrameRate(video?.avg_frame_rate ?? video?.r_frame_rate),
      bitrate,
      video_codec: video?.codec_name ?? null,
      audio_codec: audio?.codec_name ?? null,
      variants: null,
    };
  } catch (error) {
    log.debug(`ffprobe failed for ${url}: ${(error as Error).message.slice(0, 120)}`);
    return null;
  }
}

/**
 * Checks a single stream.
 *
 * Strategy: fetch the manifest over HTTP first (cheap, gives latency + status
 * code + HLS variant info), then optionally run ffprobe for real media
 * metadata. A stream is `online` when the manifest is reachable *and*
 * looks like a playlist or ffprobe found decodable media.
 */
export async function probeStream(url: string, options: ProbeOptions): Promise<HealthCheck> {
  const checkedAt = new Date().toISOString();
  const started = performance.now();

  let httpStatus: number | null = null;
  let status: StreamStatus = 'unknown';
  let error: string | null = null;
  let media: StreamMedia | null = null;
  let latency: number | null = null;

  const isHttp = /^https?:\/\//i.test(url);

  if (isHttp) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), options.timeoutMs);
    try {
      const headers: Record<string, string> = {
        accept: '*/*',
        'user-agent': options.userAgent ?? DEFAULT_USER_AGENT,
      };
      if (options.referrer) {
        headers['referer'] = options.referrer;
        try {
          headers['origin'] = new URL(options.referrer).origin;
        } catch {
          /* not a full URL */
        }
      }

      const response = await fetch(url, {
        headers,
        signal: controller.signal,
        redirect: 'follow',
      });
      latency = Math.round(performance.now() - started);
      httpStatus = response.status;
      status = statusFromHttp(response.status);

      if (response.ok && response.body) {
        // Read a bounded prefix — enough for a manifest, never a full stream.
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (total < 256 * 1024) {
          const { done, value } = await reader.read();
          if (done || !value) break;
          chunks.push(value);
          total += value.length;
        }
        void reader.cancel().catch(() => undefined);

        const prefix = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
          'utf8',
          0,
          Math.min(total, 64 * 1024),
        );

        if (prefix.includes('#EXTM3U')) {
          const { variants, bestHeight, bestBandwidth } = parseMasterPlaylist(prefix);
          if (variants > 0 || prefix.includes('#EXTINF') || prefix.includes('#EXT-X-TARGETDURATION')) {
            media = {
              width: null,
              height: bestHeight,
              resolution: qualityFromHeight(bestHeight),
              frame_rate: null,
              bitrate: bestBandwidth,
              video_codec: null,
              audio_codec: null,
              variants: variants || null,
            };
          } else {
            status = 'error';
            error = 'empty playlist';
          }
        } else if (total === 0) {
          status = 'offline';
          error = 'empty response';
        }
        // Non-M3U bodies (MPEG-TS, DASH, MP4) are left to ffprobe.
      }
    } catch (caught) {
      const classified = classifyError(caught);
      status = classified.status;
      error = classified.message;
      latency = Math.round(performance.now() - started);
    } finally {
      clearTimeout(timer);
    }
  }

  // ffprobe fills in real media details, and can rescue non-HTTP protocols.
  const shouldProbe =
    options.useFfprobe &&
    (await hasFfprobe()) &&
    (!isHttp || status === 'online' || media === null);

  if (shouldProbe) {
    const probed = await ffprobeStream(url, options);
    if (probed) {
      media = { ...probed, variants: media?.variants ?? probed.variants };
      status = 'online';
      error = null;
    } else if (!isHttp) {
      status = 'offline';
      error = error ?? 'ffprobe could not open the stream';
    } else if (status === 'online' && media === null) {
      // HTTP said 200 but nothing decodable came back.
      status = 'error';
      error = error ?? 'no decodable media';
    }
  }

  if (status === 'unknown' && !isHttp) {
    status = 'error';
    error = 'unsupported protocol without ffprobe';
  }

  return {
    checked_at: checkedAt,
    status,
    latency_ms: latency,
    http_status: httpStatus,
    error,
    media,
  };
}
