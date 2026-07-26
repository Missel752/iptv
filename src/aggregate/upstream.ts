/** Client for the upstream iptv-org JSON API, with mirror fallback and caching. */

import path from 'node:path';
import { httpGetJson } from '../core/http.js';
import { PATHS, type Settings } from '../core/config.js';
import { Logger } from '../core/logger.js';
import { mapConcurrent } from '../core/concurrency.js';
import type {
  BlocklistEntry,
  Category,
  Channel,
  Country,
  Feed,
  Guide,
  Language,
  Logo,
  Region,
  Stream,
  Subdivision,
  Timezone,
} from '../core/types.js';

const log = new Logger('upstream');

export interface UpstreamData {
  channels: Channel[];
  feeds: Feed[];
  logos: Logo[];
  streams: Stream[];
  guides: Guide[];
  categories: Category[];
  languages: Language[];
  countries: Country[];
  subdivisions: Subdivision[];
  regions: Region[];
  timezones: Timezone[];
  blocklist: BlocklistEntry[];
  fetched_at: string;
  source: string;
}

const ENDPOINTS = [
  'channels',
  'feeds',
  'logos',
  'streams',
  'guides',
  'categories',
  'languages',
  'countries',
  'subdivisions',
  'regions',
  'timezones',
  'blocklist',
] as const;

type Endpoint = (typeof ENDPOINTS)[number];

/**
 * Fetches one endpoint, trying the primary API first and the raw.githubusercontent
 * mirror second. Both host the same generated files, so either is authoritative.
 */
async function fetchEndpoint<T>(
  endpoint: Endpoint,
  settings: Settings,
): Promise<{ data: T[]; source: string }> {
  const bases = [settings.aggregate.upstream_api, settings.aggregate.upstream_mirror].filter(
    (base, index, all) => base && all.indexOf(base) === index,
  );

  let lastError: unknown;
  for (const base of bases) {
    const url = `${base.replace(/\/+$/, '')}/${endpoint}.json`;
    try {
      const data = await httpGetJson<T[]>(url, {
        cacheDir: path.join(PATHS.cache, 'upstream'),
        cacheTtlMs: settings.aggregate.cache_ttl_minutes * 60_000,
        timeoutMs: 60_000,
        attempts: 2,
      });
      if (!Array.isArray(data)) throw new Error(`${url} did not return an array`);
      return { data, source: base };
    } catch (error) {
      lastError = error;
      log.warn(`${endpoint} failed from ${base}: ${(error as Error).message}`);
    }
  }
  throw new Error(
    `Could not fetch ${endpoint} from any upstream: ${(lastError as Error)?.message ?? 'unknown'}`,
  );
}

/** Downloads the whole upstream dataset in parallel. */
export async function fetchUpstream(settings: Settings): Promise<UpstreamData> {
  log.info(`Fetching upstream dataset (${ENDPOINTS.length} endpoints)`);

  const results = await mapConcurrent(
    ENDPOINTS,
    async (endpoint) => ({ endpoint, ...(await fetchEndpoint<unknown>(endpoint, settings)) }),
    { concurrency: settings.aggregate.http_concurrency, tolerant: true },
  );

  const byEndpoint = new Map<string, unknown[]>();
  let source = settings.aggregate.upstream_api;
  for (const result of results) {
    if (!result) continue;
    byEndpoint.set(result.endpoint, result.data);
    source = result.source;
  }

  // Only the core endpoints are load-bearing; the rest degrade to empty lists.
  for (const required of ['channels', 'streams'] as const) {
    if (!byEndpoint.has(required)) {
      throw new Error(`Upstream fetch failed: ${required}.json is unavailable`);
    }
  }

  const get = <T>(endpoint: Endpoint): T[] => (byEndpoint.get(endpoint) ?? []) as T[];

  const data: UpstreamData = {
    channels: get<Channel>('channels'),
    feeds: get<Feed>('feeds'),
    logos: get<Logo>('logos'),
    streams: get<Stream>('streams'),
    guides: get<Guide>('guides'),
    categories: get<Category>('categories'),
    languages: get<Language>('languages'),
    countries: get<Country>('countries'),
    subdivisions: get<Subdivision>('subdivisions'),
    regions: get<Region>('regions'),
    timezones: get<Timezone>('timezones'),
    blocklist: get<BlocklistEntry>('blocklist'),
    fetched_at: new Date().toISOString(),
    source,
  };

  log.success(
    `Upstream: ${data.channels.length} channels, ${data.streams.length} streams, ` +
      `${data.guides.length} guides, ${data.feeds.length} feeds`,
  );
  return data;
}

/** Picks the best logo for each channel: in-use first, then largest. */
export function buildLogoIndex(logos: readonly Logo[]): Map<string, string> {
  const best = new Map<string, Logo>();
  for (const logo of logos) {
    if (!logo.channel || !logo.url) continue;
    const current = best.get(logo.channel);
    if (!current) {
      best.set(logo.channel, logo);
      continue;
    }
    const currentScore = (current.in_use ? 1e9 : 0) + current.width * current.height;
    const candidateScore = (logo.in_use ? 1e9 : 0) + logo.width * logo.height;
    if (candidateScore > currentScore) best.set(logo.channel, logo);
  }
  return new Map([...best].map(([channel, logo]) => [channel, logo.url]));
}
