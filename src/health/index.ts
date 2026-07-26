/** Health scan orchestration: probes streams, updates scores, retires dead links. */

import { loadConfig, PATHS } from '../core/config.js';
import { Logger } from '../core/logger.js';
import { mapConcurrent, shard } from '../core/concurrency.js';
import { writeJson, ensureDir } from '../core/fs.js';
import type { EnrichedStream, HealthRecord, Stream } from '../core/types.js';
import { loadDataset, loadHealthDb, saveHealthDb } from '../aggregate/index.js';
import { probeStream, hasFfprobe } from './probe.js';
import { applyCheck, isRetired, summarise, type HealthSummary, type ScoringOptions } from './scoring.js';

const log = new Logger('health');

export interface HealthScanOptions {
  /** Split the workload across parallel CI jobs. */
  shardCount?: number;
  shardIndex?: number;
  /** Only check this many streams (useful for smoke tests). */
  limit?: number;
  /** Re-check streams already checked within this window. */
  minAgeMinutes?: number;
  /** Check every stream regardless of age. */
  force?: boolean;
  concurrency?: number;
}

export interface HealthScanResult {
  checked: number;
  skipped: number;
  retired: string[];
  summary: HealthSummary;
  duration_ms: number;
}

interface Checkable {
  key: string;
  url: string;
  referrer: string | null;
  user_agent: string | null;
}

function collectStreams(channels: Array<{ streams: EnrichedStream[] }>, orphans: EnrichedStream[]): Checkable[] {
  const seen = new Map<string, Checkable>();
  const add = (stream: Stream & { key: string }): void => {
    if (seen.has(stream.key)) return;
    seen.set(stream.key, {
      key: stream.key,
      url: stream.url,
      referrer: stream.referrer,
      user_agent: stream.user_agent,
    });
  };
  for (const channel of channels) for (const stream of channel.streams) add(stream);
  for (const stream of orphans) add(stream);
  return [...seen.values()];
}

/**
 * Runs a health scan over the current dataset.
 *
 * Streams are prioritised: never-checked first, then oldest check first. That
 * way a time-boxed CI job always makes progress on the least-known streams.
 */
export async function runHealthScan(options: HealthScanOptions = {}): Promise<HealthScanResult> {
  const started = Date.now();
  const config = await loadConfig();
  const { health: settings } = config.settings;

  const scoring: ScoringOptions = {
    alpha: settings.score_alpha,
    retireAfterFailures: settings.retire_after_failures,
    historySize: settings.history_size,
  };

  const dataset = await loadDataset();
  if (!dataset) {
    throw new Error('No dataset found. Run `aggregate` before `health`.');
  }

  const db = await loadHealthDb();
  let candidates = collectStreams(dataset.channels, dataset.orphans);

  // Drop records for streams that no longer exist anywhere.
  const liveKeys = new Set(candidates.map((candidate) => candidate.key));
  for (const key of [...db.keys()]) {
    if (!liveKeys.has(key)) db.delete(key);
  }

  const minAgeMs = (options.minAgeMinutes ?? 0) * 60_000;
  const now = Date.now();
  const total = candidates.length;

  if (!options.force && minAgeMs > 0) {
    candidates = candidates.filter((candidate) => {
      const record = db.get(candidate.key);
      if (!record) return true;
      return now - new Date(record.checked_at).getTime() >= minAgeMs;
    });
  }

  // Least-known first.
  candidates.sort((a, b) => {
    const recordA = db.get(a.key);
    const recordB = db.get(b.key);
    if (!recordA && !recordB) return 0;
    if (!recordA) return -1;
    if (!recordB) return 1;
    return new Date(recordA.checked_at).getTime() - new Date(recordB.checked_at).getTime();
  });

  if (options.shardCount && options.shardCount > 1) {
    candidates = shard(candidates, options.shardCount, options.shardIndex ?? 0);
    log.info(`Shard ${(options.shardIndex ?? 0) + 1}/${options.shardCount}`);
  }
  if (options.limit && options.limit > 0) candidates = candidates.slice(0, options.limit);

  const useFfprobe = settings.use_ffprobe && (await hasFfprobe());
  const concurrency = options.concurrency ?? settings.concurrency;

  log.info(
    `Checking ${candidates.length}/${total} streams ` +
      `(concurrency ${concurrency}, ffprobe ${useFfprobe ? 'on' : 'off'})`,
  );

  const tick = log.progress(candidates.length, 'probing');
  let online = 0;

  await mapConcurrent(
    candidates,
    async (candidate) => {
      const check = await probeStream(candidate.url, {
        timeoutMs: settings.timeout_seconds * 1000,
        userAgent: candidate.user_agent,
        referrer: candidate.referrer,
        useFfprobe,
        probeDuration: settings.probe_duration,
      });
      if (check.status === 'online') online++;
      const record = applyCheck(
        candidate.key,
        candidate.url,
        check,
        db.get(candidate.key) ?? null,
        scoring,
      );
      db.set(candidate.key, record);
      return record;
    },
    {
      concurrency,
      tolerant: true,
      onProgress: (done) => tick(done, `${online} online`),
    },
  );

  const records = [...db.values()];
  const retired = records.filter((record) => isRetired(record, scoring)).map((record) => record.key);

  await saveHealthDb(db);

  const summary = summarise(records, scoring, settings.healthy_threshold);
  await ensureDir(PATHS.data);
  await writeJson(
    `${PATHS.data}/health-summary.json`,
    { generated_at: new Date().toISOString(), ...summary },
    { pretty: true },
  );

  log.success(
    `Scan complete: ${online}/${candidates.length} online, ` +
      `${summary.healthy} healthy overall, ${retired.length} retired`,
  );

  return {
    checked: candidates.length,
    skipped: total - candidates.length,
    retired,
    summary,
    duration_ms: Date.now() - started,
  };
}

/** Removes retired streams from the dataset and rewrites it. */
export async function pruneRetired(): Promise<{ removed: number; channels: number }> {
  const config = await loadConfig();
  const scoring: ScoringOptions = {
    alpha: config.settings.health.score_alpha,
    retireAfterFailures: config.settings.health.retire_after_failures,
    historySize: config.settings.health.history_size,
  };

  const dataset = await loadDataset();
  if (!dataset) throw new Error('No dataset found. Run `aggregate` first.');

  const db = await loadHealthDb();
  const dead = new Set(
    [...db.values()].filter((record) => isRetired(record, scoring)).map((record) => record.key),
  );

  let removed = 0;
  for (const channel of dataset.channels) {
    const before = channel.streams.length;
    channel.streams = channel.streams.filter((stream) => !dead.has(stream.key));
    removed += before - channel.streams.length;
    channel.online = channel.streams.some((stream) => stream.health?.status === 'online');
  }
  const beforeOrphans = dataset.orphans.length;
  dataset.orphans = dataset.orphans.filter((stream) => !dead.has(stream.key));
  removed += beforeOrphans - dataset.orphans.length;

  const { saveDataset } = await import('../aggregate/index.js');
  await saveDataset(dataset);

  log.info(`Pruned ${removed} retired stream(s)`);
  return { removed, channels: dataset.channels.length };
}

/** Re-attaches the persisted health records to an in-memory dataset. */
export function attachHealth(
  channels: Array<{ streams: EnrichedStream[]; score: number; online: boolean }>,
  db: Map<string, HealthRecord>,
): void {
  for (const channel of channels) {
    for (const stream of channel.streams) {
      stream.health = db.get(stream.key) ?? null;
    }
    // Mirrors mergeDataset: an inconclusive record (only ever `blocked`) does
    // not contribute a score, so the UI can honestly say "unchecked".
    const scored = channel.streams.filter((stream) => (stream.health?.history.length ?? 0) > 0);
    channel.score =
      scored.length > 0 ? Math.round(Math.max(...scored.map((stream) => stream.health!.score))) : 0;
    channel.online = channel.streams.some((stream) => stream.health?.status === 'online');
  }
}

export * from './probe.js';
export * from './scoring.js';
