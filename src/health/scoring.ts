/** Rolling availability scoring and retirement rules. */

import type { HealthCheck, HealthRecord, StreamStatus } from '../core/types.js';

export interface ScoringOptions {
  /** Weight of the newest observation (0-1). Higher reacts faster. */
  alpha: number;
  /** Consecutive failures before a stream is considered retired. */
  retireAfterFailures: number;
  /** Max samples kept in `history`. */
  historySize: number;
}

/** A status that means the stream served playable content. */
export function isUp(status: StreamStatus): boolean {
  return status === 'online';
}

/**
 * A `blocked` result is not the stream's fault — it usually means the CI runner
 * is geo-restricted. Penalising it fully would delete perfectly good regional
 * channels, so it decays the score far more gently and never retires a stream.
 */
function observationValue(status: StreamStatus): number | null {
  switch (status) {
    case 'online':
      return 100;
    case 'blocked':
      return null; // ignored by the EMA
    case 'timeout':
      return 20;
    case 'offline':
    case 'error':
      return 0;
    default:
      return null;
  }
}

/** Applies a new check to an existing record (or creates one). */
export function applyCheck(
  key: string,
  url: string,
  check: HealthCheck,
  previous: HealthRecord | null,
  options: ScoringOptions,
): HealthRecord {
  const up = isUp(check.status);
  const value = observationValue(check.status);

  const base: HealthRecord =
    previous ??
    {
      key,
      url,
      status: 'unknown',
      // A brand new stream starts optimistic-but-unproven so it is neither
      // promoted above proven streams nor immediately retired.
      score: 50,
      checked_at: check.checked_at,
      first_seen: check.checked_at,
      last_online: null,
      failures: 0,
      checks: 0,
      latency_ms: null,
      http_status: null,
      error: null,
      media: null,
      history: [],
    };

  const score =
    value === null
      ? base.score
      : Math.round((base.checks === 0 ? value : options.alpha * value + (1 - options.alpha) * base.score) * 10) / 10;

  const history = value === null ? base.history : [...base.history, up ? 1 : 0];
  if (history.length > options.historySize) history.splice(0, history.length - options.historySize);

  return {
    key,
    url,
    status: check.status,
    score: Math.max(0, Math.min(100, score)),
    checked_at: check.checked_at,
    first_seen: base.first_seen,
    last_online: up ? check.checked_at : base.last_online,
    failures: up || check.status === 'blocked' ? 0 : base.failures + 1,
    checks: base.checks + 1,
    latency_ms: check.latency_ms,
    http_status: check.http_status,
    error: check.error,
    // Keep the last known media details when a check fails — they are still
    // the best description of the stream we have.
    media: check.media ?? base.media,
    history,
  };
}

/** True when a stream has failed often enough to be dropped from outputs. */
export function isRetired(record: HealthRecord, options: ScoringOptions): boolean {
  return record.failures >= options.retireAfterFailures && record.score < 5;
}

/** Uptime ratio over the recorded history, as a percentage. */
export function uptimeRatio(record: HealthRecord): number {
  if (record.history.length === 0) return 0;
  const up = record.history.reduce((sum, value) => sum + value, 0);
  return Math.round((up / record.history.length) * 1000) / 10;
}

export interface HealthSummary {
  total: number;
  online: number;
  offline: number;
  blocked: number;
  timeout: number;
  error: number;
  unknown: number;
  healthy: number;
  retired: number;
  average_score: number;
  average_latency_ms: number | null;
  by_resolution: Record<string, number>;
}

/** Aggregates a health database into a report. */
export function summarise(
  records: readonly HealthRecord[],
  options: ScoringOptions,
  healthyThreshold: number,
): HealthSummary {
  const summary: HealthSummary = {
    total: records.length,
    online: 0,
    offline: 0,
    blocked: 0,
    timeout: 0,
    error: 0,
    unknown: 0,
    healthy: 0,
    retired: 0,
    average_score: 0,
    average_latency_ms: null,
    by_resolution: {},
  };

  let scoreSum = 0;
  let latencySum = 0;
  let latencyCount = 0;

  for (const record of records) {
    switch (record.status) {
      case 'online':
        summary.online++;
        break;
      case 'offline':
        summary.offline++;
        break;
      case 'blocked':
        summary.blocked++;
        break;
      case 'timeout':
        summary.timeout++;
        break;
      case 'error':
        summary.error++;
        break;
      default:
        summary.unknown++;
    }

    if (record.score >= healthyThreshold) summary.healthy++;
    if (isRetired(record, options)) summary.retired++;
    scoreSum += record.score;

    if (record.latency_ms !== null) {
      latencySum += record.latency_ms;
      latencyCount++;
    }

    const resolution = record.media?.resolution;
    if (resolution) {
      summary.by_resolution[resolution] = (summary.by_resolution[resolution] ?? 0) + 1;
    }
  }

  summary.average_score =
    records.length > 0 ? Math.round((scoreSum / records.length) * 10) / 10 : 0;
  summary.average_latency_ms = latencyCount > 0 ? Math.round(latencySum / latencyCount) : null;

  return summary;
}
