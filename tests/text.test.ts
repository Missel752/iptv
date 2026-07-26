import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  cleanTitle,
  diceCoefficient,
  extractQuality,
  levenshtein,
  matchKey,
  normalize,
  qualityFromHeight,
  qualityWeight,
  similarity,
  slugify,
  bestMatch,
} from '../src/core/text.js';

describe('normalize', () => {
  it('strips diacritics and punctuation', () => {
    assert.equal(normalize('Kanal D — Türkiye!'), 'kanal d turkiye');
    assert.equal(normalize('CANAL+ Séries'), 'canal series');
  });

  it('expands ampersands', () => {
    assert.equal(normalize('A&E'), 'a and e');
  });

  it('handles Turkish dotted/dotless i', () => {
    assert.equal(normalize('İZ TV'), 'iz tv');
    assert.equal(normalize('Sınav TV'), 'sinav tv');
  });

  it('returns an empty string for symbol-only input', () => {
    assert.equal(normalize('!!! ???'), '');
  });
});

describe('matchKey', () => {
  it('drops noise words so quality variants collapse together', () => {
    assert.equal(matchKey('BBC News HD'), matchKey('BBC News'));
    assert.equal(matchKey('TRT 1 FHD'), matchKey('TRT 1'));
  });

  it('keeps something when every token is noise', () => {
    assert.notEqual(matchKey('HD TV'), '');
  });

  it('is stable across separators', () => {
    assert.equal(matchKey('Sky-Sports_1'), matchKey('Sky Sports 1'));
  });
});

describe('quality helpers', () => {
  it('extracts a quality label from a title', () => {
    assert.equal(extractQuality('CNN Türk FHD'), '1080p');
    assert.equal(extractQuality('Discovery 4K'), '2160p');
    assert.equal(extractQuality('Local News'), null);
  });

  it('maps pixel height to a label with tolerance', () => {
    assert.equal(qualityFromHeight(1080), '1080p');
    assert.equal(qualityFromHeight(1088), '1080p');
    assert.equal(qualityFromHeight(1024), '1080p'); // within 8% of 1080
    assert.equal(qualityFromHeight(null), null);
  });

  it('weights quality labels numerically', () => {
    assert.ok(qualityWeight('1080p') > qualityWeight('720p'));
    assert.equal(qualityWeight(null), 0);
  });
});

describe('cleanTitle', () => {
  it('removes quality and codec noise', () => {
    assert.equal(cleanTitle('TRT Spor 1080p'), 'TRT Spor');
    assert.equal(cleanTitle('BBC One [UK] (1080p H265)'), 'BBC One');
  });

  it('leaves clean titles alone', () => {
    assert.equal(cleanTitle('Al Jazeera English'), 'Al Jazeera English');
  });
});

describe('similarity', () => {
  it('scores identical strings at 1', () => {
    assert.equal(similarity('bbcnews', 'bbcnews'), 1);
  });

  it('scores unrelated strings low', () => {
    assert.ok(similarity('bbcnews', 'aljazeera') < 0.4);
  });

  it('rewards containment', () => {
    assert.ok(similarity('bbcnews', 'bbcnewsworld') > 0.85);
  });

  it('is symmetric', () => {
    const a = similarity('skysports', 'skysport');
    const b = similarity('skysport', 'skysports');
    assert.equal(Math.round(a * 1000), Math.round(b * 1000));
  });

  it('handles empty input', () => {
    assert.equal(similarity('', 'abc'), 0);
  });
});

describe('levenshtein', () => {
  it('computes the expected distance', () => {
    assert.equal(levenshtein('kitten', 'sitting'), 3);
    assert.equal(levenshtein('abc', 'abc'), 0);
  });

  it('respects the early-exit bound', () => {
    assert.ok(levenshtein('a'.repeat(40), 'b'.repeat(40), 3) > 3);
  });
});

describe('diceCoefficient', () => {
  it('is 1 for identical strings and 0 for short input', () => {
    assert.equal(diceCoefficient('night', 'night'), 1);
    assert.equal(diceCoefficient('a', 'b'), 0);
  });
});

describe('bestMatch', () => {
  const items = [{ name: 'bbcnews' }, { name: 'bbcone' }, { name: 'aljazeera' }];

  it('finds the closest candidate above the threshold', () => {
    const match = bestMatch('bbcnews', items, (item) => item.name, 0.8);
    assert.equal(match?.item.name, 'bbcnews');
  });

  it('returns null when nothing clears the threshold', () => {
    assert.equal(bestMatch('cnnturk', items, (item) => item.name, 0.9), null);
  });
});

describe('slugify', () => {
  it('produces url-safe keys', () => {
    assert.equal(slugify('Türkiye / Genel'), 'turkiye-genel');
  });
});
