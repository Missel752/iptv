/**
 * Channel resolution.
 *
 * Upstream streams already carry a `channel` id. Streams from third-party
 * playlists usually do not, so we resolve them: exact `tvg-id`, then alias
 * lookup, then fuzzy name matching constrained by country when we can infer one.
 */

import { bestMatch, cleanTitle, matchKey, normalize, similarity } from '../core/text.js';
import type { Channel, Feed } from '../core/types.js';

export interface ChannelIndex {
  /** Channel id → channel. */
  byId: Map<string, Channel>;
  /** Lowercased id → channel, for case-insensitive `tvg-id` lookups. */
  byLowerId: Map<string, Channel>;
  /** Match key (name + alt names) → channels sharing that key. */
  byName: Map<string, Channel[]>;
  /** Country code → channels, used to narrow fuzzy searches. */
  byCountry: Map<string, Channel[]>;
  /** Flattened search keys per channel, cached for fuzzy scoring. */
  keys: Map<string, string[]>;
  /** Feed id (`channel@feed`) → feed. */
  feeds: Map<string, Feed>;
  all: Channel[];
}

function addTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const bucket = map.get(key);
  if (bucket) bucket.push(value);
  else map.set(key, [value]);
}

/** Builds all lookup structures once so matching stays O(1)–O(n_country). */
export function buildChannelIndex(channels: readonly Channel[], feeds: readonly Feed[]): ChannelIndex {
  const index: ChannelIndex = {
    byId: new Map(),
    byLowerId: new Map(),
    byName: new Map(),
    byCountry: new Map(),
    keys: new Map(),
    feeds: new Map(),
    all: [...channels],
  };

  for (const channel of channels) {
    index.byId.set(channel.id, channel);
    index.byLowerId.set(channel.id.toLowerCase(), channel);

    const names = [channel.name, ...channel.alt_names].filter(Boolean);
    const keys = [...new Set(names.map((name) => matchKey(name)).filter(Boolean))];
    index.keys.set(channel.id, keys);
    for (const key of keys) addTo(index.byName, key, channel);
    if (channel.country) addTo(index.byCountry, channel.country.toUpperCase(), channel);
  }

  for (const feed of feeds) {
    index.feeds.set(`${feed.channel}@${feed.id}`, feed);
  }

  return index;
}

export interface MatchHints {
  /** `tvg-id` from the playlist entry. */
  tvgId?: string | null;
  /** `group-title`, often "Country" or "Category". */
  group?: string | null;
  /** Two-letter country code forced by the source config. */
  country?: string | null;
  /** ISO country codes derived from the source or title. */
  countryHints?: string[];
}

export interface MatchResult {
  channel: Channel;
  score: number;
  method: 'tvg-id' | 'exact' | 'alias' | 'fuzzy';
}

/** Extracts a `[XX]`/`(XX)` country prefix commonly used in community playlists. */
export function guessCountry(title: string, group?: string | null): string | null {
  const patterns = [/^\s*[[(]([A-Za-z]{2})[\])]/, /^\s*([A-Z]{2})\s*[|:-]/];
  for (const source of [title, group ?? '']) {
    for (const pattern of patterns) {
      const match = pattern.exec(source);
      const code = match?.[1]?.toUpperCase();
      if (code && code !== 'TV' && code !== 'HD') return code;
    }
  }
  return null;
}

/**
 * Resolves a stream title to a known channel.
 *
 * Ordering matters: an explicit `tvg-id` is authoritative, an exact normalised
 * name is next, then fuzzy matching. Fuzzy matching is restricted to the
 * inferred country when one is available, which removes most false positives
 * (e.g. dozens of unrelated "Sport 1" channels across Europe).
 */
export function resolveChannel(
  title: string,
  index: ChannelIndex,
  hints: MatchHints = {},
  threshold = 0.86,
): MatchResult | null {
  // 1. Explicit tvg-id.
  const tvgId = hints.tvgId?.trim();
  if (tvgId) {
    const direct = index.byId.get(tvgId) ?? index.byLowerId.get(tvgId.toLowerCase());
    if (direct) return { channel: direct, score: 1, method: 'tvg-id' };
    // Some playlists use `channel@feed` ids.
    const base = tvgId.split('@')[0];
    if (base) {
      const viaFeed = index.byId.get(base) ?? index.byLowerId.get(base.toLowerCase());
      if (viaFeed) return { channel: viaFeed, score: 0.98, method: 'tvg-id' };
    }
  }

  const cleaned = cleanTitle(title);
  const key = matchKey(cleaned || title);
  if (!key) return null;

  // Country hints are resolved up front: they disambiguate *both* the exact
  // and the fuzzy path. Doing this only for fuzzy would silently pick the
  // wrong "Sport 1" whenever two countries share a channel name exactly.
  const countries = new Set<string>();
  const explicit = hints.country?.toUpperCase();
  if (explicit) countries.add(explicit);
  for (const hint of hints.countryHints ?? []) countries.add(hint.toUpperCase());
  const guessed = guessCountry(title, hints.group);
  if (guessed) countries.add(guessed);

  const resolvedHints: MatchHints = { ...hints, countryHints: [...countries] };

  // 2. Exact normalised-name hit.
  const exact = index.byName.get(key);
  if (exact && exact.length > 0) {
    const preferred = pickByCountry(exact, resolvedHints);
    return { channel: preferred, score: 0.97, method: exact.length === 1 ? 'exact' : 'alias' };
  }

  // 3. Fuzzy, narrowed by country when possible.
  let pool: Channel[] = [];
  for (const country of countries) pool.push(...(index.byCountry.get(country) ?? []));
  // Fall back to the global pool only when no country narrowed the search.
  if (pool.length === 0) pool = index.all;

  const match = bestMatch(
    key,
    pool,
    (channel) => index.keys.get(channel.id) ?? [matchKey(channel.name)],
    threshold,
  );
  if (!match) return null;
  return { channel: match.item, score: match.score, method: 'fuzzy' };
}

/** Prefers the candidate whose country matches the hints. */
function pickByCountry(candidates: readonly Channel[], hints: MatchHints): Channel {
  const first = candidates[0]!;
  if (candidates.length === 1) return first;
  const wanted = new Set(
    [hints.country, ...(hints.countryHints ?? [])]
      .filter((value): value is string => Boolean(value))
      .map((value) => value.toUpperCase()),
  );
  if (wanted.size > 0) {
    const hit = candidates.find((channel) => wanted.has(channel.country?.toUpperCase() ?? ''));
    if (hit) return hit;
  }
  // Otherwise prefer the channel that is still on air with the shortest name.
  const open = candidates.filter((channel) => !channel.closed);
  const pool = open.length > 0 ? open : candidates;
  return [...pool].sort((a, b) => a.name.length - b.name.length)[0]!;
}

/** Resolves an EPG display name against the channel index. */
export function resolveEpgChannel(
  displayNames: readonly string[],
  index: ChannelIndex,
  hints: MatchHints = {},
  threshold = 0.88,
): MatchResult | null {
  let best: MatchResult | null = null;
  for (const name of displayNames) {
    const result = resolveChannel(name, index, hints, threshold);
    if (result && (best === null || result.score > best.score)) best = result;
    if (best?.score === 1) break;
  }
  return best;
}

/** Similarity between two free-form channel names, on the normalised key. */
export function nameSimilarity(a: string, b: string): number {
  return similarity(matchKey(a), matchKey(b));
}

export { normalize };
