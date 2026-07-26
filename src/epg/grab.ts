/** Downloads and parses XMLTV guides declared in `config/epg-sources.yml`. */

import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { httpGet } from '../core/http.js';
import { PATHS, type EpgSource, type Settings } from '../core/config.js';
import { Logger } from '../core/logger.js';
import { mapConcurrent } from '../core/concurrency.js';
import { parseXmltv } from '../core/xmltv.js';
import type { EpgBundle } from '../core/types.js';

const log = new Logger('epg:grab');

/** Decompresses `.gz` payloads and decodes to text. */
function decode(body: Buffer): string {
  let buffer = body;
  if (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    try {
      buffer = gunzipSync(buffer);
    } catch {
      /* already decompressed */
    }
  }
  return buffer.toString('utf8');
}

/** Fetches and parses one guide. Returns `null` when the source is unusable. */
export async function grabSource(
  source: EpgSource,
  settings: Settings,
): Promise<EpgBundle | null> {
  try {
    const response = await httpGet(source.url, {
      cacheDir: path.join(PATHS.cache, 'epg'),
      // Guides change slowly; a short TTL avoids re-downloading within a run.
      cacheTtlMs: 30 * 60_000,
      timeoutMs: 180_000,
      attempts: 2,
    });

    const xml = decode(response.body);
    if (!xml.includes('<tv')) {
      log.warn(`EPG source "${source.id}" did not return XMLTV`);
      return null;
    }

    const { channels, programmes } = parseXmltv(xml, source.id);
    log.info(
      `EPG "${source.id}": ${channels.length} channels, ${programmes.length} programmes` +
        (response.fromCache ? ' (cached)' : ''),
    );

    return {
      site: source.id,
      generated_at: new Date().toISOString(),
      channels,
      programmes: trimWindow(programmes, settings),
    };
  } catch (error) {
    log.warn(`EPG source "${source.id}" failed: ${(error as Error).message}`);
    return null;
  }
}

/** Keeps only programmes inside the configured time window. */
function trimWindow(
  programmes: EpgBundle['programmes'],
  settings: Settings,
): EpgBundle['programmes'] {
  const now = Date.now();
  const from = now - settings.epg.retain_past_hours * 3_600_000;
  const to = now + settings.epg.days * 86_400_000;

  return programmes.filter((programme) => {
    const stop = new Date(programme.stop || programme.start).getTime();
    const start = new Date(programme.start).getTime();
    if (Number.isNaN(start)) return false;
    return stop >= from && start <= to;
  });
}

/** Grabs every enabled EPG source concurrently. */
export async function grabAll(
  sources: readonly EpgSource[],
  settings: Settings,
): Promise<EpgBundle[]> {
  const active = sources.filter((source) => source.enabled);
  if (active.length === 0) {
    log.warn('No EPG sources enabled');
    return [];
  }

  log.info(`Grabbing ${active.length} EPG source(s)`);
  const results = await mapConcurrent(active, (source) => grabSource(source, settings), {
    concurrency: settings.epg.concurrency,
    tolerant: true,
  });

  return results.filter((bundle): bundle is EpgBundle => bundle !== null && bundle !== undefined);
}
