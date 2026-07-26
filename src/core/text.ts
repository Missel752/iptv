/** Text normalisation, slugging and fuzzy matching used across the pipeline. */

const DIACRITIC_RE = /[\u0300-\u036f]/g;

/** Words that carry no identity for a channel name. */
const NOISE_TOKENS = new Set([
  'tv',
  'television',
  'televizyon',
  'channel',
  'kanal',
  'canal',
  'canale',
  'kanaal',
  'network',
  'hd',
  'fhd',
  'uhd',
  'sd',
  'hq',
  'lq',
  '4k',
  '8k',
  '1080p',
  '1080',
  '720p',
  '720',
  '576p',
  '480p',
  '360p',
  'fullhd',
  'full',
  'live',
  'canli',
  'online',
  'stream',
  'streaming',
  'backup',
  'alt',
  'mirror',
  'test',
  'the',
  'el',
  'la',
  'de',
]);

/** Quality tokens we can lift out of a raw stream title. */
const QUALITY_PATTERNS: Array<[RegExp, string]> = [
  [/\b(4320p?|8k)\b/i, '4320p'],
  [/\b(2160p?|4k|uhd)\b/i, '2160p'],
  [/\b1440p?\b/i, '1440p'],
  [/\b(1080p?|fhd|full\s*hd)\b/i, '1080p'],
  [/\b720p?\b/i, '720p'],
  [/\b576p?\b/i, '576p'],
  [/\b480p?\b/i, '480p'],
  [/\b360p?\b/i, '360p'],
  [/\b240p?\b/i, '240p'],
];

/** Lowercases, strips diacritics and collapses punctuation to single spaces. */
export function normalize(input: string): string {
  return input
    .normalize('NFD')
    .replace(DIACRITIC_RE, '')
    .toLowerCase()
    .replace(/[àáâãäå]/g, 'a')
    .replace(/[èéêë]/g, 'e')
    .replace(/[ìíîï]/g, 'i')
    .replace(/[òóôõö]/g, 'o')
    .replace(/[ùúûü]/g, 'u')
    .replace(/[ç]/g, 'c')
    .replace(/[ğ]/g, 'g')
    .replace(/[ş]/g, 's')
    .replace(/[ıİ]/g, 'i')
    .replace(/[ñ]/g, 'n')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Normalised form with noise words removed — the key used for name matching. */
export function matchKey(input: string): string {
  const tokens = normalize(input)
    .split(' ')
    .filter((token) => token.length > 0 && !NOISE_TOKENS.has(token));
  // Keep the original tokens if stripping removed everything (e.g. "HD TV").
  if (tokens.length === 0) return normalize(input).replace(/\s+/g, '');
  return tokens.join('');
}

export function slugify(input: string): string {
  return normalize(input).replace(/\s+/g, '-');
}

/** Extracts a quality label such as `1080p` from a free-form title. */
export function extractQuality(title: string): string | null {
  for (const [pattern, label] of QUALITY_PATTERNS) {
    if (pattern.test(title)) return label;
  }
  return null;
}

/** Maps a pixel height to the conventional quality label. */
export function qualityFromHeight(height: number | null | undefined): string | null {
  if (!height || height <= 0) return null;
  const ladder = [4320, 2160, 1440, 1080, 720, 576, 480, 360, 240, 144];
  for (const step of ladder) {
    if (height >= step - step * 0.08) return `${step}p`;
  }
  return `${height}p`;
}

/** Numeric weight for a quality label, used for ranking. */
export function qualityWeight(quality: string | null | undefined): number {
  if (!quality) return 0;
  const match = /(\d{3,4})/.exec(quality);
  return match?.[1] ? Number.parseInt(match[1], 10) : 0;
}

/** Removes quality/bitrate noise from a stream title to recover the channel name. */
export function cleanTitle(title: string): string {
  return title
    .replace(/\((?:[^()]*(?:\d{3,4}p|hd|sd|uhd|4k|kbps|fps)[^()]*)\)/gi, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\b\d{3,4}p\b/gi, '')
    .replace(/\b(?:fhd|uhd|hevc|h\.?26[45]|aac|mpeg2?|kbps|fps)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s\-–—_|]+$/g, '')
    .trim();
}

// ---------------------------------------------------------------------------
// Similarity
// ---------------------------------------------------------------------------

/** Levenshtein distance with an early-exit bound. */
export function levenshtein(a: string, b: string, maxDistance = Infinity): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;

  let previous = new Array<number>(b.length + 1);
  let current = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) previous[j] = j;

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    let rowMin = current[0]!;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + cost);
      current[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > maxDistance) return maxDistance + 1;
    [previous, current] = [current, previous];
  }
  return previous[b.length]!;
}

/** 0-1 similarity derived from Levenshtein distance. */
export function levenshteinRatio(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - levenshtein(a, b) / longest;
}

/** Sørensen–Dice coefficient over character bigrams — robust to word order. */
export function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const bigrams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const gram = a.slice(i, i + 2);
    bigrams.set(gram, (bigrams.get(gram) ?? 0) + 1);
  }

  let intersection = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const gram = b.slice(i, i + 2);
    const count = bigrams.get(gram) ?? 0;
    if (count > 0) {
      bigrams.set(gram, count - 1);
      intersection++;
    }
  }
  return (2 * intersection) / (a.length - 1 + (b.length - 1));
}

/**
 * Blended similarity in 0-1. Dice handles reordering and long names well while
 * Levenshtein punishes character-level drift; the max of the two is forgiving
 * enough for real-world playlist titles without being reckless.
 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const dice = diceCoefficient(a, b);
  const lev = levenshteinRatio(a, b);
  const blended = Math.max(dice, lev) * 0.7 + Math.min(dice, lev) * 0.3;
  // Containment bonus: "bbcnewshd" vs "bbcnews".
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length >= 4 && longer.includes(shorter)) {
    return Math.max(blended, 0.88 + 0.12 * (shorter.length / longer.length));
  }
  return blended;
}

export interface BestMatch<T> {
  item: T;
  score: number;
}

/** Finds the highest-scoring candidate above `threshold`. */
export function bestMatch<T>(
  needle: string,
  candidates: readonly T[],
  keyOf: (item: T) => string | string[],
  threshold = 0.82,
): BestMatch<T> | null {
  let best: BestMatch<T> | null = null;
  for (const item of candidates) {
    const keys = keyOf(item);
    const list = Array.isArray(keys) ? keys : [keys];
    for (const key of list) {
      const score = similarity(needle, key);
      if (score >= threshold && (best === null || score > best.score)) {
        best = { item, score };
        if (score === 1) return best;
      }
    }
  }
  return best;
}
