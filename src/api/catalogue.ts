/**
 * Generates `PLAYLISTS.md` — the human-readable index of every generated
 * playlist, committed back to the repository so it renders on GitHub.
 *
 * This is the file people actually copy URLs out of, so it leads with the
 * handful of playlists most users want and pushes the 400-odd shards into
 * collapsed sections.
 */

import type { Settings } from '../core/config.js';
import { publicUrl } from '../core/config.js';
import type { PlaylistIndexEntry } from './playlists.js';

interface CatalogueInput {
  settings: Settings;
  generatedAt: string;
  files: readonly PlaylistIndexEntry[];
  counts: {
    channels: number;
    playable_channels: number;
    streams: number;
    online_streams: number;
    epg_programmes: number;
  };
  countryFlags: Map<string, string>;
}

function url(settings: Settings, relativePath: string): string {
  return publicUrl(settings, relativePath);
}

function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
}

/** Builds the full PLAYLISTS.md document. */
export function buildPlaylistCatalogue(input: CatalogueInput): string {
  const { settings, files, counts, generatedAt } = input;
  const byGroup = new Map<string, PlaylistIndexEntry[]>();
  for (const file of files) {
    const bucket = byGroup.get(file.group) ?? [];
    bucket.push(file);
    byGroup.set(file.group, bucket);
  }

  const out: string[] = [
    '# Playlists',
    '',
    '> Generated automatically — do not edit by hand.',
    `> Last updated **${generatedAt.replace('T', ' ').slice(0, 16)} UTC**.`,
    '',
    `${formatNumber(counts.playable_channels)} channels with a working stream, ` +
      `out of ${formatNumber(counts.channels)} indexed. ` +
      `${formatNumber(counts.online_streams)} streams responded on the last scan.`,
    '',
    '## Main playlists',
    '',
    'Paste any of these into VLC, TiviMate, IPTVnator, Kodi or any player that',
    'takes an M3U URL. The EPG is wired in through `x-tvg-url`, so most players',
    'pick up the programme guide on their own.',
    '',
    '| Playlist | What it contains | URL |',
    '| --- | --- | --- |',
    `| **Best** | One stream per channel, highest ranked first. **Start here.** | \`${url(settings, 'playlists/best.m3u')}\` |`,
    `| **Working only** | Only streams that passed the latest health check | \`${url(settings, 'playlists/online.m3u')}\` |`,
    `| **Everything** | Every stream of every channel, including backups | \`${url(settings, 'playlists/index.m3u')}\` |`,
    '',
    '## Programme guide (EPG)',
    '',
    '| Guide | URL |',
    '| --- | --- |',
    `| All channels | \`${url(settings, 'epg/guide.xml.gz')}\` |`,
    `| Per country | \`${url(settings, 'epg/{country}.xml.gz')}\` — e.g. \`tr\`, \`us\`, \`de\` |`,
    '',
    '## API',
    '',
    'Every playlist here is also queryable as JSON. See',
    `[\`docs/API.md\`](docs/API.md) or the [OpenAPI schema](${url(settings, 'api/v1/openapi.json')}).`,
    '',
  ];

  const section = (
    group: string,
    title: string,
    description: string,
    labelHeader: string,
  ): void => {
    const bucket = byGroup.get(group);
    if (!bucket || bucket.length === 0) return;

    const sorted = [...bucket].sort((a, b) => b.channels - a.channels);
    out.push(
      `## By ${title}`,
      '',
      description,
      '',
      `<details>`,
      `<summary><b>${sorted.length} playlists</b> — click to expand</summary>`,
      '',
      `| ${labelHeader} | Channels | Streams | URL |`,
      '| --- | ---: | ---: | --- |',
    );

    for (const file of sorted) {
      const flag = input.countryFlags.get(file.name) ?? '';
      const label = flag ? `${flag} ${file.name}` : file.name;
      out.push(
        `| ${label.replace(/\|/g, '\\|')} | ${formatNumber(file.channels)} | ` +
          `${formatNumber(file.streams)} | \`${url(settings, file.path)}\` |`,
      );
    }

    out.push('', '</details>', '');
  };

  section(
    'country',
    'country',
    'One playlist per country, best stream per channel.',
    'Country',
  );
  section(
    'category',
    'category',
    'One playlist per category — news, sports, movies, music and so on.',
    'Category',
  );
  section(
    'language',
    'language',
    'One playlist per broadcast language.',
    'Language',
  );

  out.push(
    '---',
    '',
    'Streams are indexed, not hosted. A playlist entry describes a stream that is',
    'already publicly listed elsewhere; if one stops working it is scored down and',
    'eventually dropped automatically. See [`docs/LEGAL.md`](docs/LEGAL.md).',
    '',
  );

  return out.join('\n');
}

/** A short block for the README, kept in sync with the catalogue. */
export function buildReadmePlaylistBlock(settings: Settings): string {
  return [
    '<!-- PLAYLISTS:START -->',
    '',
    '| Playlist | Contents | URL |',
    '| --- | --- | --- |',
    `| **Best** | One stream per channel, best first | \`${url(settings, 'playlists/best.m3u')}\` |`,
    `| **Working only** | Only streams that passed the last health check | \`${url(settings, 'playlists/online.m3u')}\` |`,
    `| **Everything** | Every stream, including backups | \`${url(settings, 'playlists/index.m3u')}\` |`,
    `| **EPG** | Programme guide for every linked channel | \`${url(settings, 'epg/guide.xml.gz')}\` |`,
    '',
    'Per-country, per-category and per-language playlists: [**PLAYLISTS.md**](PLAYLISTS.md).',
    '',
    '<!-- PLAYLISTS:END -->',
  ].join('\n');
}
