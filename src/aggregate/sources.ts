/** Loads additional M3U/JSON stream sources declared in `config/sources.yml`. */

import path from 'node:path';
import { httpGetText } from '../core/http.js';
import { isPlayableUrl, streamKey } from '../core/http.js';
import { parseM3u } from '../core/m3u.js';
import { PATHS, type Settings, type StreamSource } from '../core/config.js';
import { Logger } from '../core/logger.js';
import { mapConcurrent } from '../core/concurrency.js';
import { cleanTitle, extractQuality } from '../core/text.js';
import type { Stream, StreamProvenance } from '../core/types.js';

const log = new Logger('sources');

export interface SourcedStream extends Stream {
  key: string;
  provenance: StreamProvenance;
  /** Raw group / tvg attributes, used later for channel matching. */
  attributes: Record<string, string>;
  trust: number;
}

interface JsonStreamShape {
  channel?: string | null;
  tvg_id?: string | null;
  feed?: string | null;
  name?: string;
  title?: string;
  url: string;
  referrer?: string | null;
  referer?: string | null;
  user_agent?: string | null;
  quality?: string | null;
  logo?: string | null;
  group?: string | null;
}

function compile(pattern: string | undefined): RegExp | null {
  if (!pattern) return null;
  try {
    return new RegExp(pattern, 'i');
  } catch (error) {
    log.warn(`Invalid regex "${pattern}": ${(error as Error).message}`);
    return null;
  }
}

/** Reads one source and returns its streams. Never throws — a bad source is skipped. */
export async function loadSource(
  source: StreamSource,
  settings: Settings,
): Promise<SourcedStream[]> {
  const include = compile(source.include);
  const exclude = compile(source.exclude);
  const addedAt = new Date().toISOString();

  let raw: string;
  try {
    raw = await httpGetText(source.url, {
      cacheDir: path.join(PATHS.cache, 'sources'),
      cacheTtlMs: settings.aggregate.cache_ttl_minutes * 60_000,
      timeoutMs: 90_000,
      attempts: 2,
    });
  } catch (error) {
    log.warn(`Source "${source.id}" unreachable: ${(error as Error).message}`);
    return [];
  }

  const streams: SourcedStream[] = [];
  const seen = new Set<string>();

  const push = (candidate: Omit<SourcedStream, 'key' | 'provenance' | 'trust'>): void => {
    if (!isPlayableUrl(candidate.url)) return;
    const title = candidate.title.trim();
    if (!title) return;
    if (include && !include.test(title)) return;
    if (exclude && exclude.test(title)) return;

    const key = streamKey(candidate.url);
    if (seen.has(key)) return;
    seen.add(key);

    streams.push({
      ...candidate,
      key,
      trust: source.trust,
      provenance: { source: source.id, origin: source.url, added_at: addedAt },
    });
  };

  if (source.type === 'json') {
    let parsed: JsonStreamShape[] = [];
    try {
      const data = JSON.parse(raw) as unknown;
      parsed = Array.isArray(data) ? (data as JsonStreamShape[]) : [];
    } catch (error) {
      log.warn(`Source "${source.id}" is not valid JSON: ${(error as Error).message}`);
      return [];
    }
    for (const entry of parsed) {
      if (!entry?.url) continue;
      const title = entry.title ?? entry.name ?? '';
      push({
        channel: entry.channel ?? entry.tvg_id ?? null,
        feed: entry.feed ?? null,
        title,
        url: entry.url,
        referrer: entry.referrer ?? entry.referer ?? null,
        user_agent: entry.user_agent ?? null,
        quality: entry.quality ?? extractQuality(title),
        attributes: {
          'tvg-id': entry.channel ?? entry.tvg_id ?? '',
          'tvg-logo': entry.logo ?? '',
          'group-title': entry.group ?? (source.categories?.[0] ?? ''),
        },
      });
    }
  } else {
    const playlist = parseM3u(raw);
    for (const entry of playlist.entries) {
      const tvgId = entry.attributes['tvg-id']?.trim() || null;
      const title = entry.title || entry.attributes['tvg-name'] || '';
      push({
        channel: tvgId,
        feed: null,
        title: cleanTitle(title) || title,
        url: entry.url,
        referrer: entry.headers['referer'] ?? entry.headers['referrer'] ?? null,
        user_agent: entry.headers['user-agent'] ?? null,
        quality: extractQuality(title),
        attributes: {
          ...entry.attributes,
          'group-title': entry.group ?? entry.attributes['group-title'] ?? '',
        },
      });
    }
  }

  log.info(`Source "${source.id}": ${streams.length} streams`);
  return streams;
}

/** Loads every enabled non-upstream source concurrently. */
export async function loadExtraSources(
  sources: readonly StreamSource[],
  settings: Settings,
): Promise<SourcedStream[]> {
  const active = sources.filter((source) => source.enabled && source.type !== 'iptv-org');
  if (active.length === 0) return [];

  log.info(`Loading ${active.length} additional source(s)`);
  const results = await mapConcurrent(
    active,
    (source) => loadSource(source, settings),
    { concurrency: Math.min(6, settings.aggregate.http_concurrency), tolerant: true },
  );

  return results.flatMap((result) => result ?? []);
}
