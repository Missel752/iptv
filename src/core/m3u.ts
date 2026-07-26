/** Tolerant M3U/M3U8 playlist parser and writer. */

import type { M3uEntry, M3uPlaylist } from './types.js';

const ATTRIBUTE_RE = /([\w-]+)\s*=\s*"([^"]*)"|([\w-]+)\s*=\s*'([^']*)'|([\w-]+)\s*=\s*([^\s,]+)/g;

/** Parses `key="value"` pairs from an `#EXTINF` or `#EXTM3U` line. */
export function parseAttributes(input: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  ATTRIBUTE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTRIBUTE_RE.exec(input)) !== null) {
    const key = (match[1] ?? match[3] ?? match[5])?.toLowerCase();
    const value = match[2] ?? match[4] ?? match[6] ?? '';
    if (key) attributes[key] = value.trim();
  }
  return attributes;
}

interface PendingEntry {
  duration: number;
  title: string;
  attributes: Record<string, string>;
  headers: Record<string, string>;
  group: string | null;
}

function emptyPending(): PendingEntry {
  return { duration: -1, title: '', attributes: {}, headers: {}, group: null };
}

/**
 * Parses an M3U playlist.
 *
 * Handles real-world quirks: missing `#EXTM3U` headers, CRLF line endings,
 * `#EXTVLCOPT` / `#EXTHTTP` / `#EXTGRP` directives, Kodi-style `|Header=value`
 * URL suffixes and comment lines interleaved with entries.
 */
export function parseM3u(content: string): M3uPlaylist {
  const playlist: M3uPlaylist = { header: {}, entries: [] };
  const lines = content.replace(/\r\n?/g, '\n').split('\n');

  let pending: PendingEntry | null = null;
  let currentGroup: string | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;

    if (line.startsWith('#EXTM3U')) {
      Object.assign(playlist.header, parseAttributes(line.slice(7)));
      continue;
    }

    if (line.startsWith('#EXTINF')) {
      pending = emptyPending();
      const body = line.slice(line.indexOf(':') + 1);
      const commaIndex = lastUnquotedComma(body);
      const meta = commaIndex >= 0 ? body.slice(0, commaIndex) : body;
      pending.title = (commaIndex >= 0 ? body.slice(commaIndex + 1) : '').trim();
      const durationMatch = /^\s*(-?\d+(?:\.\d+)?)/.exec(meta);
      pending.duration = durationMatch?.[1] ? Number.parseFloat(durationMatch[1]) : -1;
      pending.attributes = parseAttributes(meta);
      pending.group = pending.attributes['group-title'] ?? currentGroup;
      continue;
    }

    if (line.startsWith('#EXTGRP')) {
      currentGroup = line.slice(line.indexOf(':') + 1).trim();
      if (pending) pending.group = currentGroup;
      continue;
    }

    if (line.startsWith('#EXTVLCOPT')) {
      const value = line.slice(line.indexOf(':') + 1);
      const separator = value.indexOf('=');
      if (separator > 0 && pending) {
        const key = value.slice(0, separator).trim().toLowerCase();
        const headerValue = value.slice(separator + 1).trim();
        if (key === 'http-user-agent') pending.headers['user-agent'] = headerValue;
        else if (key === 'http-referrer' || key === 'http-referer') {
          pending.headers['referer'] = headerValue;
        } else pending.headers[key.replace(/^http-/, '')] = headerValue;
      }
      continue;
    }

    if (line.startsWith('#EXTHTTP')) {
      const value = line.slice(line.indexOf(':') + 1).trim();
      try {
        const parsed = JSON.parse(value) as Record<string, string>;
        if (pending) {
          for (const [key, headerValue] of Object.entries(parsed)) {
            pending.headers[key.toLowerCase()] = String(headerValue);
          }
        }
      } catch {
        /* malformed EXTHTTP — ignore */
      }
      continue;
    }

    if (line.startsWith('#KODIPROP')) {
      const value = line.slice(line.indexOf(':') + 1);
      const separator = value.indexOf('=');
      if (separator > 0 && pending) {
        pending.headers[value.slice(0, separator).trim().toLowerCase()] = value
          .slice(separator + 1)
          .trim();
      }
      continue;
    }

    if (line.startsWith('#')) continue;

    // Anything else is a URL.
    const entry = pending ?? emptyPending();
    let url = line;

    // Kodi/VLC pipe syntax: url|User-Agent=x&Referer=y
    const pipeIndex = url.indexOf('|');
    if (pipeIndex > 0 && /^https?:\/\//i.test(url)) {
      const headerPart = url.slice(pipeIndex + 1);
      url = url.slice(0, pipeIndex);
      for (const pair of headerPart.split('&')) {
        const separator = pair.indexOf('=');
        if (separator > 0) {
          entry.headers[pair.slice(0, separator).trim().toLowerCase()] = decodeURIComponent(
            pair.slice(separator + 1).trim(),
          );
        }
      }
    }

    playlist.entries.push({
      duration: entry.duration,
      title: entry.title || entry.attributes['tvg-name'] || '',
      url: url.trim(),
      attributes: entry.attributes,
      headers: entry.headers,
      group: entry.group,
    });
    pending = null;
  }

  return playlist;
}

/** Finds the comma separating `#EXTINF` metadata from the title, ignoring quotes. */
function lastUnquotedComma(input: string): number {
  let inQuote: string | null = null;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === '"' || char === "'") {
      if (inQuote === char) inQuote = null;
      else if (inQuote === null) inQuote = char;
    } else if (char === ',' && inQuote === null) {
      return i;
    }
  }
  return -1;
}

export interface WriteM3uOptions {
  /** Attributes for the `#EXTM3U` header, e.g. `x-tvg-url`. */
  header?: Record<string, string>;
  /** Emit `#EXTVLCOPT` lines for user-agent/referrer. Defaults to true. */
  includeHeaders?: boolean;
}

function escapeAttribute(value: string): string {
  return value.replace(/"/g, "'").replace(/[\r\n]+/g, ' ');
}

/** Serialises entries back into an M3U document. */
export function writeM3u(entries: readonly M3uEntry[], options: WriteM3uOptions = {}): string {
  const { header = {}, includeHeaders = true } = options;
  const headerAttributes = Object.entries(header)
    .filter(([, value]) => value)
    .map(([key, value]) => ` ${key}="${escapeAttribute(value)}"`)
    .join('');

  const lines: string[] = [`#EXTM3U${headerAttributes}`];

  for (const entry of entries) {
    const attributes = Object.entries(entry.attributes)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => ` ${key}="${escapeAttribute(String(value))}"`)
      .join('');
    lines.push(`#EXTINF:${entry.duration}${attributes},${entry.title}`);
    if (includeHeaders) {
      const userAgent = entry.headers['user-agent'];
      const referer = entry.headers['referer'] ?? entry.headers['referrer'];
      if (userAgent) lines.push(`#EXTVLCOPT:http-user-agent=${userAgent}`);
      if (referer) lines.push(`#EXTVLCOPT:http-referrer=${referer}`);
    }
    lines.push(entry.url);
  }

  return `${lines.join('\n')}\n`;
}
