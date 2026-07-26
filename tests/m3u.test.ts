import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseM3u, writeM3u, parseAttributes } from '../src/core/m3u.js';

describe('parseAttributes', () => {
  it('reads double, single and unquoted values', () => {
    const attributes = parseAttributes('tvg-id="A.us" tvg-name=\'B\' group-title=News');
    assert.equal(attributes['tvg-id'], 'A.us');
    assert.equal(attributes['tvg-name'], 'B');
    assert.equal(attributes['group-title'], 'News');
  });
});

describe('parseM3u', () => {
  it('parses a standard playlist', () => {
    const playlist = parseM3u(
      [
        '#EXTM3U x-tvg-url="https://example.com/guide.xml"',
        '#EXTINF:-1 tvg-id="BBCNews.uk" tvg-logo="https://example.com/l.png" group-title="News",BBC News',
        'https://example.com/bbcnews.m3u8',
      ].join('\n'),
    );

    assert.equal(playlist.header['x-tvg-url'], 'https://example.com/guide.xml');
    assert.equal(playlist.entries.length, 1);
    const entry = playlist.entries[0]!;
    assert.equal(entry.title, 'BBC News');
    assert.equal(entry.url, 'https://example.com/bbcnews.m3u8');
    assert.equal(entry.attributes['tvg-id'], 'BBCNews.uk');
    assert.equal(entry.group, 'News');
  });

  it('tolerates CRLF, comments and a missing header', () => {
    const playlist = parseM3u(
      '#EXTINF:-1,Channel A\r\n# a comment\r\nhttps://a.example/a.m3u8\r\n\r\n#EXTINF:-1,Channel B\r\nhttps://b.example/b.m3u8',
    );
    assert.equal(playlist.entries.length, 2);
    assert.equal(playlist.entries[1]!.title, 'Channel B');
  });

  it('reads EXTVLCOPT headers', () => {
    const playlist = parseM3u(
      [
        '#EXTM3U',
        '#EXTINF:-1,Guarded',
        '#EXTVLCOPT:http-user-agent=CustomUA/1.0',
        '#EXTVLCOPT:http-referrer=https://ref.example/',
        'https://example.com/s.m3u8',
      ].join('\n'),
    );
    const entry = playlist.entries[0]!;
    assert.equal(entry.headers['user-agent'], 'CustomUA/1.0');
    assert.equal(entry.headers['referer'], 'https://ref.example/');
  });

  it('reads EXTGRP as a fallback group', () => {
    const playlist = parseM3u(
      ['#EXTM3U', '#EXTGRP:Sports', '#EXTINF:-1,Match', 'https://example.com/m.m3u8'].join('\n'),
    );
    assert.equal(playlist.entries[0]!.group, 'Sports');
  });

  it('splits Kodi pipe headers off the URL', () => {
    const playlist = parseM3u(
      ['#EXTM3U', '#EXTINF:-1,Piped', 'https://example.com/s.m3u8|User-Agent=UA&Referer=https%3A%2F%2Fr.example%2F'].join('\n'),
    );
    const entry = playlist.entries[0]!;
    assert.equal(entry.url, 'https://example.com/s.m3u8');
    assert.equal(entry.headers['user-agent'], 'UA');
    assert.equal(entry.headers['referer'], 'https://r.example/');
  });

  it('handles commas inside quoted attributes', () => {
    const playlist = parseM3u(
      ['#EXTM3U', '#EXTINF:-1 tvg-name="News, Live" group-title="A, B",Real Title', 'https://example.com/x.m3u8'].join('\n'),
    );
    assert.equal(playlist.entries[0]!.title, 'Real Title');
    assert.equal(playlist.entries[0]!.attributes['group-title'], 'A, B');
  });

  it('returns an empty playlist for empty input', () => {
    assert.deepEqual(parseM3u('').entries, []);
  });
});

describe('writeM3u', () => {
  it('round-trips through the parser', () => {
    const original = parseM3u(
      [
        '#EXTM3U',
        '#EXTINF:-1 tvg-id="A.us" tvg-logo="https://l.example/a.png" group-title="News",Alpha',
        '#EXTVLCOPT:http-user-agent=UA/2',
        'https://example.com/a.m3u8',
      ].join('\n'),
    );

    const rendered = writeM3u(original.entries, { header: { 'x-tvg-url': 'https://g.example/g.xml' } });
    const reparsed = parseM3u(rendered);

    assert.equal(reparsed.header['x-tvg-url'], 'https://g.example/g.xml');
    assert.equal(reparsed.entries.length, 1);
    assert.equal(reparsed.entries[0]!.title, 'Alpha');
    assert.equal(reparsed.entries[0]!.attributes['tvg-id'], 'A.us');
    assert.equal(reparsed.entries[0]!.headers['user-agent'], 'UA/2');
  });

  it('escapes quotes in attribute values', () => {
    const rendered = writeM3u([
      {
        duration: -1,
        title: 'Q',
        url: 'https://example.com/q.m3u8',
        attributes: { 'tvg-name': 'He said "hi"' },
        headers: {},
        group: null,
      },
    ]);
    assert.ok(!rendered.includes('said "hi"'));
    assert.equal(parseM3u(rendered).entries.length, 1);
  });
});
