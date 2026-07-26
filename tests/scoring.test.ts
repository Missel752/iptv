import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyCheck, isRetired, summarise, uptimeRatio } from '../src/health/scoring.js';
import type { HealthCheck, HealthRecord, StreamStatus } from '../src/core/types.js';

const OPTIONS = { alpha: 0.3, retireAfterFailures: 5, historySize: 10 };

function check(status: StreamStatus, at = '2024-01-01T00:00:00.000Z'): HealthCheck {
  return {
    checked_at: at,
    status,
    latency_ms: status === 'online' ? 120 : null,
    http_status: status === 'online' ? 200 : 404,
    error: status === 'online' ? null : 'boom',
    media:
      status === 'online'
        ? {
            width: 1920,
            height: 1080,
            resolution: '1080p',
            frame_rate: 25,
            bitrate: 3_000_000,
            video_codec: 'h264',
            audio_codec: 'aac',
            variants: 3,
          }
        : null,
  };
}

function chain(statuses: StreamStatus[]): HealthRecord {
  let record: HealthRecord | null = null;
  statuses.forEach((status, index) => {
    record = applyCheck(
      'k',
      'https://example.com/s.m3u8',
      check(status, new Date(Date.UTC(2024, 0, 1, index)).toISOString()),
      record,
      OPTIONS,
    );
  });
  return record!;
}

describe('applyCheck', () => {
  it('seeds the score from the first observation, not the 50 default', () => {
    const record = chain(['online']);
    assert.equal(record.score, 100);
    assert.equal(record.checks, 1);
    assert.equal(record.failures, 0);
    assert.equal(record.last_online, record.checked_at);
  });

  it('decays gradually rather than condemning on one failure', () => {
    const record = chain(['online', 'offline']);
    assert.ok(record.score > 50, `expected a gentle decay, got ${record.score}`);
    assert.equal(record.failures, 1);
  });

  it('converges towards zero after sustained failure', () => {
    const record = chain(['online', ...Array<StreamStatus>(10).fill('offline')]);
    assert.ok(record.score < 10, `expected a low score, got ${record.score}`);
    assert.equal(record.failures, 10);
  });

  it('recovers when a stream comes back', () => {
    const down = chain(['offline', 'offline', 'offline']);
    const up = applyCheck('k', 'u', check('online'), down, OPTIONS);
    assert.ok(up.score > down.score);
    assert.equal(up.failures, 0);
  });

  it('ignores blocked results so geo-restrictions do not delete channels', () => {
    const before = chain(['online', 'online']);
    const after = applyCheck('k', 'u', check('blocked'), before, OPTIONS);
    assert.equal(after.score, before.score);
    assert.equal(after.failures, 0);
    assert.equal(after.history.length, before.history.length);
  });

  it('keeps the last known media details after a failure', () => {
    const record = applyCheck('k', 'u', check('offline'), chain(['online']), OPTIONS);
    assert.equal(record.media?.resolution, '1080p');
  });

  it('caps the history buffer', () => {
    const record = chain(Array<StreamStatus>(30).fill('online'));
    assert.equal(record.history.length, OPTIONS.historySize);
  });

  it('preserves first_seen across checks', () => {
    const record = chain(['online', 'offline', 'online']);
    assert.equal(record.first_seen, '2024-01-01T00:00:00.000Z');
  });
});

describe('isRetired', () => {
  it('retires only after sustained failure', () => {
    assert.equal(isRetired(chain(['offline', 'offline']), OPTIONS), false);
    assert.equal(isRetired(chain(Array<StreamStatus>(12).fill('offline')), OPTIONS), true);
  });

  it('never retires a stream that is merely blocked', () => {
    assert.equal(isRetired(chain(Array<StreamStatus>(12).fill('blocked')), OPTIONS), false);
  });
});

describe('uptimeRatio', () => {
  it('reports a percentage', () => {
    assert.equal(uptimeRatio(chain(['online', 'online', 'offline', 'offline'])), 50);
  });

  it('reports 0 for a record with no history', () => {
    assert.equal(uptimeRatio({ ...chain(['online']), history: [] }), 0);
  });
});

describe('summarise', () => {
  it('aggregates counts and resolutions', () => {
    const records = [
      chain(['online']),
      { ...chain(['offline']), key: 'b' },
      { ...chain(['blocked']), key: 'c' },
    ];
    const summary = summarise(records, OPTIONS, 40);
    assert.equal(summary.total, 3);
    assert.equal(summary.online, 1);
    assert.equal(summary.offline, 1);
    assert.equal(summary.blocked, 1);
    assert.equal(summary.by_resolution['1080p'], 1);
  });
});
