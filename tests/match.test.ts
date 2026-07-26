import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildChannelIndex, guessCountry, resolveChannel } from '../src/aggregate/match.js';
import { rankStream } from '../src/aggregate/merge.js';
import { streamKey, isPlayableUrl } from '../src/core/http.js';
import type { Channel, Feed, HealthRecord, Stream } from '../src/core/types.js';

function channel(id: string, name: string, country: string, alt: string[] = []): Channel {
  return {
    id,
    name,
    alt_names: alt,
    network: null,
    owners: [],
    country,
    categories: ['general'],
    is_nsfw: false,
    launched: null,
    closed: null,
    replaced_by: null,
    website: null,
  };
}

const CHANNELS: Channel[] = [
  channel('BBCNews.uk', 'BBC News', 'GB', ['BBC News Channel']),
  channel('BBCOne.uk', 'BBC One', 'GB'),
  channel('TRT1.tr', 'TRT 1', 'TR'),
  channel('TRTHaber.tr', 'TRT Haber', 'TR'),
  channel('Sport1.de', 'Sport 1', 'DE'),
  channel('Sport1.pl', 'Sport 1', 'PL'),
];

const index = buildChannelIndex(CHANNELS, [] as Feed[]);

describe('resolveChannel', () => {
  it('prefers an explicit tvg-id', () => {
    const result = resolveChannel('Totally Different Name', index, { tvgId: 'TRT1.tr' });
    assert.equal(result?.channel.id, 'TRT1.tr');
    assert.equal(result?.method, 'tvg-id');
  });

  it('accepts a channel@feed style tvg-id', () => {
    const result = resolveChannel('x', index, { tvgId: 'BBCNews.uk@main' });
    assert.equal(result?.channel.id, 'BBCNews.uk');
  });

  it('matches on an exact normalised name', () => {
    const result = resolveChannel('bbc news', index);
    assert.equal(result?.channel.id, 'BBCNews.uk');
  });

  it('matches through quality noise', () => {
    assert.equal(resolveChannel('TRT 1 FHD', index)?.channel.id, 'TRT1.tr');
    assert.equal(resolveChannel('BBC News HD', index)?.channel.id, 'BBCNews.uk');
  });

  it('matches alternative names', () => {
    assert.equal(resolveChannel('BBC News Channel', index)?.channel.id, 'BBCNews.uk');
  });

  it('uses the country hint to disambiguate identical names', () => {
    assert.equal(resolveChannel('Sport 1', index, { country: 'PL' })?.channel.id, 'Sport1.pl');
    assert.equal(resolveChannel('Sport 1', index, { country: 'DE' })?.channel.id, 'Sport1.de');
  });

  it('reads a country prefix out of the title', () => {
    assert.equal(resolveChannel('[PL] Sport 1', index)?.channel.id, 'Sport1.pl');
  });

  it('returns null for an unknown channel', () => {
    assert.equal(resolveChannel('Completely Unknown Broadcaster XYZ', index), null);
  });

  it('does not confuse similar but distinct channels', () => {
    const result = resolveChannel('TRT Haber', index);
    assert.equal(result?.channel.id, 'TRTHaber.tr');
  });
});

describe('guessCountry', () => {
  it('reads bracketed and parenthesised prefixes', () => {
    assert.equal(guessCountry('[TR] Kanal D'), 'TR');
    assert.equal(guessCountry('(DE) Das Erste'), 'DE');
  });

  it('ignores quality tokens that look like country codes', () => {
    assert.equal(guessCountry('[HD] Something'), null);
  });

  it('returns null when there is no prefix', () => {
    assert.equal(guessCountry('Al Jazeera'), null);
  });
});

describe('streamKey', () => {
  it('is stable across protocol and trailing slash', () => {
    assert.equal(
      streamKey('http://cdn.example.com/live/stream.m3u8'),
      streamKey('https://cdn.example.com/live/stream.m3u8/'),
    );
  });

  it('ignores volatile session parameters', () => {
    assert.equal(
      streamKey('https://cdn.example.com/s.m3u8?token=abc&quality=hd'),
      streamKey('https://cdn.example.com/s.m3u8?token=zzz&quality=hd'),
    );
  });

  it('keeps meaningful parameters', () => {
    assert.notEqual(
      streamKey('https://cdn.example.com/s.m3u8?channel=1'),
      streamKey('https://cdn.example.com/s.m3u8?channel=2'),
    );
  });

  it('distinguishes different hosts', () => {
    assert.notEqual(streamKey('https://a.example/s.m3u8'), streamKey('https://b.example/s.m3u8'));
  });
});

describe('isPlayableUrl', () => {
  it('accepts public http(s) and rtmp URLs', () => {
    assert.equal(isPlayableUrl('https://cdn.example.com/s.m3u8'), true);
    assert.equal(isPlayableUrl('rtmp://cdn.example.com/live'), true);
  });

  it('rejects private and local addresses', () => {
    assert.equal(isPlayableUrl('http://192.168.1.10/s.m3u8'), false);
    assert.equal(isPlayableUrl('http://localhost:8080/s.m3u8'), false);
    assert.equal(isPlayableUrl('file:///etc/passwd'), false);
    assert.equal(isPlayableUrl('not a url'), false);
  });
});

describe('rankStream', () => {
  const stream: Stream = {
    channel: 'X.us',
    feed: null,
    title: 'X',
    url: 'https://example.com/x.m3u8',
    referrer: null,
    user_agent: null,
    quality: '1080p',
  };

  function health(score: number, status: HealthRecord['status']): HealthRecord {
    return {
      key: 'k',
      url: stream.url,
      status,
      score,
      checked_at: new Date().toISOString(),
      first_seen: new Date().toISOString(),
      last_online: status === 'online' ? new Date().toISOString() : null,
      failures: 0,
      checks: 5,
      latency_ms: 200,
      http_status: 200,
      error: null,
      media: null,
      history: [1, 1, 1],
    };
  }

  it('ranks a healthy stream above a dead one', () => {
    const good = rankStream(stream, health(95, 'online'), 0.9, 40);
    const bad = rankStream(stream, health(5, 'offline'), 0.9, 40);
    assert.ok(good > bad);
  });

  it('places unknown streams between healthy and dead', () => {
    const unknown = rankStream(stream, null, 0.5, 40);
    const good = rankStream(stream, health(95, 'online'), 0.5, 40);
    const dead = rankStream(stream, health(0, 'offline'), 0.5, 40);
    assert.ok(unknown < good && unknown > dead);
  });

  it('prefers higher quality when health is equal', () => {
    const hd = rankStream({ ...stream, quality: '1080p' }, health(80, 'online'), 0.5, 40);
    const sd = rankStream({ ...stream, quality: '480p' }, health(80, 'online'), 0.5, 40);
    assert.ok(hd > sd);
  });

  it('penalises streams that need custom headers', () => {
    const plain = rankStream(stream, health(80, 'online'), 0.5, 40);
    const guarded = rankStream(
      { ...stream, referrer: 'https://r.example', user_agent: 'UA' },
      health(80, 'online'),
      0.5,
      40,
    );
    assert.ok(plain > guarded);
  });

  it('rewards trusted sources', () => {
    const trusted = rankStream(stream, health(80, 'online'), 1, 40);
    const untrusted = rankStream(stream, health(80, 'online'), 0.1, 40);
    assert.ok(trusted > untrusted);
  });
});
