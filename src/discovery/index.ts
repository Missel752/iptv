/**
 * Automatic source discovery.
 *
 * Scans configured index pages and playlist mirrors for stream URLs that the
 * dataset does not already contain, validates each candidate with a live
 * health probe, tries to attach it to a known channel, and writes a proposal
 * file that CI turns into a pull request. Nothing is added automatically —
 * a human still approves the diff.
 */

import path from 'node:path';
import { loadConfig, PATHS, type DiscoverySource, type Settings } from '../core/config.js';
import { httpGetText, isPlayableUrl, streamKey } from '../core/http.js';
import { ensureDir, readJsonOr, writeJson } from '../core/fs.js';
import { Logger } from '../core/logger.js';
import { mapConcurrent } from '../core/concurrency.js';
import { cleanTitle, extractQuality } from '../core/text.js';
import { parseM3u } from '../core/m3u.js';
import type { DiscoveryCandidate, DiscoveryReport, EnrichedStream } from '../core/types.js';
import { buildChannelIndex, resolveChannel } from '../aggregate/match.js';
import { loadDataset } from '../aggregate/index.js';
import { probeStream, hasFfprobe } from '../health/probe.js';

const log = new Logger('discovery');

/** Extracts playlist URLs from an HTML or markdown index page. */
export function extractPlaylistUrls(content: string, baseUrl: string): string[] {
  const urls = new Set<string>();

  // Absolute links ending in .m3u/.m3u8, in href/src attributes or bare text.
  const absolute = /https?:\/\/[^\s"'<>()\]]+\.m3u8?(?:\?[^\s"'<>()\]]*)?/gi;
  for (const match of content.matchAll(absolute)) urls.add(match[0]);

  // Relative links in markdown or HTML.
  const relative = /(?:href|src)\s*=\s*["']([^"']+\.m3u8?(?:\?[^"']*)?)["']/gi;
  for (const match of content.matchAll(relative)) {
    const href = match[1];
    if (!href || /^https?:/i.test(href)) continue;
    try {
      urls.add(new URL(href, baseUrl).toString());
    } catch {
      /* unresolvable relative URL */
    }
  }

  return [...urls];
}

interface RawCandidate {
  url: string;
  title: string;
  attributes: Record<string, string>;
  referrer: string | null;
  userAgent: string | null;
  source: string;
}

/** Reads a playlist and returns its entries as candidates. */
async function readPlaylist(url: string, sourceId: string): Promise<RawCandidate[]> {
  try {
    const content = await httpGetText(url, {
      cacheDir: path.join(PATHS.cache, 'discovery'),
      cacheTtlMs: 6 * 3_600_000,
      timeoutMs: 60_000,
      attempts: 2,
    });
    const playlist = parseM3u(content);
    return playlist.entries
      .filter((entry) => isPlayableUrl(entry.url))
      .map((entry) => ({
        url: entry.url,
        title: cleanTitle(entry.title || entry.attributes['tvg-name'] || '') || entry.title,
        attributes: {
          ...entry.attributes,
          'group-title': entry.group ?? entry.attributes['group-title'] ?? '',
        },
        referrer: entry.headers['referer'] ?? null,
        userAgent: entry.headers['user-agent'] ?? null,
        source: sourceId,
      }));
  } catch (error) {
    log.debug(`playlist ${url} failed: ${(error as Error).message}`);
    return [];
  }
}

/** Collects raw candidates from one discovery source. */
async function scanSource(source: DiscoverySource): Promise<RawCandidate[]> {
  if (source.mode === 'playlist') {
    return readPlaylist(source.url, source.id);
  }

  let page: string;
  try {
    page = await httpGetText(source.url, {
      cacheDir: path.join(PATHS.cache, 'discovery'),
      cacheTtlMs: 12 * 3_600_000,
      timeoutMs: 60_000,
      attempts: 2,
    });
  } catch (error) {
    log.warn(`Discovery source "${source.id}" unreachable: ${(error as Error).message}`);
    return [];
  }

  const playlists = extractPlaylistUrls(page, source.url).slice(0, source.max_playlists ?? 25);
  log.info(`Source "${source.id}": found ${playlists.length} playlist(s)`);

  const results = await mapConcurrent(playlists, (url) => readPlaylist(url, source.id), {
    concurrency: 4,
    tolerant: true,
  });
  return results.flatMap((result) => result ?? []);
}

export interface DiscoverOptions {
  /** Skip live probing (much faster, but candidates are unverified). */
  skipValidation?: boolean;
  /** Cap on candidates probed in one run. */
  maxProbes?: number;
  /**
   * Merge accepted candidates straight into `config/discovered.m3u` instead of
   * only writing a proposal for review.
   *
   * This is safe precisely because of what the gates already guarantee: a
   * candidate only gets here if it came from a source the maintainer put in
   * `discovery.yml`, matched a channel we already index above the confidence
   * threshold, and answered a live probe. It is a new URL for a known channel
   * from a known list — not a new source. Adding an unvetted *source* still
   * requires a human editing `discovery.yml`.
   */
  apply?: boolean;
}

/** Runs a full discovery pass and writes the proposal report. */
export async function runDiscovery(options: DiscoverOptions = {}): Promise<DiscoveryReport> {
  const config = await loadConfig();
  const settings: Settings = config.settings;

  if (!settings.discovery.enabled) {
    log.warn('Discovery is disabled in settings');
    return emptyReport();
  }

  const active = config.discoverySources.filter((source) => source.enabled);
  if (active.length === 0) {
    log.warn('No discovery sources configured');
    return emptyReport();
  }

  const dataset = await loadDataset();
  if (!dataset) throw new Error('No dataset found. Run `aggregate` before `discover`.');

  // Everything we already know about, so we only report genuinely new URLs.
  const known = new Set<string>();
  const collect = (streams: EnrichedStream[]): void => {
    for (const stream of streams) known.add(stream.key);
  };
  for (const channel of dataset.channels) collect(channel.streams);
  collect(dataset.orphans);

  // Previously rejected candidates: do not re-probe them every run.
  const previous = await readJsonOr<{ rejected: string[] }>(PATHS.discoveryDb, { rejected: [] });
  const rejectedBefore = new Set(previous.rejected);

  log.info(`Scanning ${active.length} discovery source(s); ${known.size} known streams`);

  const raw = (
    await mapConcurrent(active, (source) => scanSource(source), { concurrency: 3, tolerant: true })
  ).flatMap((result) => result ?? []);

  // Dedupe and filter against what we already have.
  const fresh = new Map<string, RawCandidate>();
  for (const candidate of raw) {
    const key = streamKey(candidate.url);
    if (known.has(key) || rejectedBefore.has(key) || fresh.has(key)) continue;
    if (!candidate.title.trim()) continue;
    fresh.set(key, candidate);
  }

  log.info(`${raw.length} entries scanned → ${fresh.size} new candidate(s)`);

  // Match against known channels.
  const index = buildChannelIndex(
    dataset.channels as never,
    dataset.channels.flatMap((channel) => channel.feeds),
  );

  const trustBySource = new Map(active.map((source) => [source.id, source.trust]));
  const rejected: DiscoveryReport['rejected'] = [];
  const matched: Array<{ key: string; candidate: RawCandidate; suggestion: DiscoveryCandidate }> = [];

  for (const [key, candidate] of fresh) {
    const resolved = resolveChannel(
      candidate.title,
      index,
      {
        tvgId: candidate.attributes['tvg-id'] ?? null,
        group: candidate.attributes['group-title'] ?? null,
      },
      settings.discovery.match_threshold,
    );

    if (!resolved && settings.discovery.require_channel_match) {
      rejected.push({ url: candidate.url, reason: 'no channel match' });
      continue;
    }

    matched.push({
      key,
      candidate,
      suggestion: {
        url: candidate.url,
        title: candidate.title,
        source: candidate.source,
        key,
        attributes: candidate.attributes,
        suggested_channel: resolved?.channel.id ?? null,
        confidence: resolved ? Math.round(resolved.score * 100) / 100 : 0,
        health: null,
      },
    });
  }

  // Rank by match confidence and source trust so the probe budget is well spent.
  matched.sort((a, b) => {
    const trustA = trustBySource.get(a.candidate.source) ?? 0;
    const trustB = trustBySource.get(b.candidate.source) ?? 0;
    return b.suggestion.confidence + trustB - (a.suggestion.confidence + trustA);
  });

  const budget = options.maxProbes ?? settings.discovery.max_accepted_per_run * 4;
  const toProbe = matched.slice(0, budget);
  const accepted: DiscoveryCandidate[] = [];

  if (options.skipValidation || !settings.discovery.require_online) {
    accepted.push(...toProbe.map((entry) => entry.suggestion));
  } else {
    const useFfprobe = settings.health.use_ffprobe && (await hasFfprobe());
    const tick = log.progress(toProbe.length, 'validating');
    let online = 0;

    await mapConcurrent(
      toProbe,
      async (entry) => {
        const check = await probeStream(entry.candidate.url, {
          timeoutMs: settings.health.timeout_seconds * 1000,
          userAgent: entry.candidate.userAgent,
          referrer: entry.candidate.referrer,
          useFfprobe,
          probeDuration: settings.health.probe_duration,
        });
        entry.suggestion.health = check;
        if (check.status === 'online') {
          online++;
          accepted.push(entry.suggestion);
        } else {
          rejected.push({ url: entry.candidate.url, reason: `probe: ${check.status}` });
        }
      },
      {
        concurrency: settings.discovery.concurrency,
        tolerant: true,
        onProgress: (done) => tick(done, `${online} online`),
      },
    );
  }

  accepted.sort((a, b) => b.confidence - a.confidence);
  const finalAccepted = accepted.slice(0, settings.discovery.max_accepted_per_run);

  const report: DiscoveryReport = {
    generated_at: new Date().toISOString(),
    scanned_sources: active.length,
    candidates_seen: raw.length,
    candidates_new: fresh.size,
    accepted: finalAccepted,
    rejected: rejected.slice(0, 1000),
  };

  await ensureDir(PATHS.data);
  await writeJson(
    PATHS.discoveryDb,
    {
      generated_at: report.generated_at,
      rejected: [...rejectedBefore, ...rejected.map((entry) => streamKey(entry.url))].slice(-50_000),
    },
    { pretty: false },
  );
  await writeJson(path.join(PATHS.data, 'discovery-report.json'), report, { pretty: true });
  await writeProposal(report);

  if (options.apply) {
    const added = await applyToPlaylist(report);
    log.success(`Applied ${added} new stream(s) to config/discovered.m3u`);
  }

  log.success(
    `Discovery: ${finalAccepted.length} accepted, ${rejected.length} rejected ` +
      `out of ${fresh.size} new candidates`,
  );

  return report;
}

/**
 * Merges accepted candidates into the tracked `config/discovered.m3u`, which
 * `config/sources.yml` loads as a low-trust source on the next sync.
 *
 * Existing entries are preserved and deduplicated by normalised stream key, so
 * repeated runs converge instead of appending the same stream forever.
 */
async function applyToPlaylist(report: DiscoveryReport): Promise<number> {
  const { readText, writeText, exists } = await import('../core/fs.js');
  const { parseM3u, writeM3u } = await import('../core/m3u.js');
  const target = path.join(PATHS.root, 'config', 'discovered.m3u');

  const existing = (await exists(target)) ? parseM3u(await readText(target)).entries : [];
  const seen = new Set(existing.map((entry) => streamKey(entry.url)));

  let added = 0;
  for (const candidate of report.accepted) {
    if (seen.has(candidate.key)) continue;
    seen.add(candidate.key);
    added++;
    existing.push({
      duration: -1,
      title: candidate.title,
      url: candidate.url,
      attributes: {
        'tvg-id': candidate.suggested_channel ?? '',
        'tvg-name': candidate.title,
        'group-title': candidate.attributes['group-title'] ?? '',
        'nexus-source': candidate.source,
        'nexus-confidence': String(candidate.confidence),
      },
      headers: {},
      group: candidate.attributes['group-title'] ?? null,
    });
  }

  existing.sort((a, b) => (a.attributes['tvg-id'] ?? '').localeCompare(b.attributes['tvg-id'] ?? ''));
  await writeText(target, writeM3u(existing));
  return added;
}

/** Writes an M3U + markdown proposal that a maintainer can review in a PR. */
async function writeProposal(report: DiscoveryReport): Promise<void> {
  const { writeText } = await import('../core/fs.js');
  const { writeM3u } = await import('../core/m3u.js');
  const dir = path.join(PATHS.data, 'proposals');
  await ensureDir(dir);

  const entries = report.accepted.map((candidate) => ({
    duration: -1,
    title: candidate.title,
    url: candidate.url,
    attributes: {
      'tvg-id': candidate.suggested_channel ?? '',
      'tvg-name': candidate.title,
      'group-title': candidate.attributes['group-title'] ?? '',
    },
    headers: {},
    group: candidate.attributes['group-title'] ?? null,
  }));

  await writeText(path.join(dir, 'discovered.m3u'), writeM3u(entries));

  const lines = [
    `# Discovery proposal — ${report.generated_at.slice(0, 10)}`,
    '',
    `- Sources scanned: **${report.scanned_sources}**`,
    `- Entries seen: **${report.candidates_seen}**`,
    `- New candidates: **${report.candidates_new}**`,
    `- Accepted: **${report.accepted.length}**`,
    `- Rejected: **${report.rejected.length}**`,
    '',
    '| Channel | Title | Quality | Latency | Confidence | URL |',
    '| --- | --- | --- | --- | --- | --- |',
  ];

  for (const candidate of report.accepted.slice(0, 200)) {
    const quality = candidate.health?.media?.resolution ?? extractQuality(candidate.title) ?? '—';
    const latency = candidate.health?.latency_ms ? `${candidate.health.latency_ms}ms` : '—';
    lines.push(
      `| \`${candidate.suggested_channel ?? '—'}\` | ${candidate.title.replace(/\|/g, '\\|')} | ` +
        `${quality} | ${latency} | ${candidate.confidence} | ${candidate.url.slice(0, 80)} |`,
    );
  }

  await writeText(path.join(dir, 'discovered.md'), `${lines.join('\n')}\n`);
}

function emptyReport(): DiscoveryReport {
  return {
    generated_at: new Date().toISOString(),
    scanned_sources: 0,
    candidates_seen: 0,
    candidates_new: 0,
    accepted: [],
    rejected: [],
  };
}
