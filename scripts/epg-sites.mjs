#!/usr/bin/env node
/**
 * Reads `config/epg-grab.yml` and prints the enabled sites.
 *
 * The EPG workflow uses this to build its job matrix, so the site list lives
 * in config next to everything else rather than duplicated inside YAML
 * workflow steps.
 *
 * Usage:
 *   node scripts/epg-sites.mjs matrix   # JSON array for fromJSON()
 *   node scripts/epg-sites.mjs list     # newline-separated site names
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configFile = path.join(root, 'config', 'epg-grab.yml');

/**
 * Minimal YAML reader for the specific shape of `epg-grab.yml`: a `sites:`
 * list of flat key/value maps. Keeping this dependency-free means the workflow
 * can build its matrix before `npm ci` has run.
 */
function parseSites(text) {
  const sites = [];
  let current = null;
  let inSites = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trimEnd();
    if (!line.trim() || line.trim().startsWith('#')) continue;

    if (/^sites:\s*$/.test(line)) {
      inSites = true;
      continue;
    }
    if (!inSites) continue;

    // A new list item starts a new site.
    const item = /^\s*-\s*(.*)$/.exec(line);
    if (item) {
      if (current) sites.push(current);
      current = {};
      const rest = item[1];
      if (rest) assign(current, rest);
      continue;
    }

    if (current) assign(current, line.trim());
  }
  if (current) sites.push(current);
  return sites;
}

function assign(target, text) {
  const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(text);
  if (!match) return;
  const [, key, rawValue] = match;
  let value = rawValue.trim();

  if (value === 'true') value = true;
  else if (value === 'false') value = false;
  else if (/^\[.*\]$/.test(value)) {
    value = value
      .slice(1, -1)
      .split(',')
      .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  } else if (/^-?\d+$/.test(value)) value = Number.parseInt(value, 10);
  else value = value.replace(/^['"]|['"]$/g, '');

  target[key] = value;
}

const text = await fs.readFile(configFile, 'utf8');
const sites = parseSites(text).filter((site) => site.site && site.enabled !== false);

if (sites.length === 0) {
  console.error('No enabled EPG sites found in config/epg-grab.yml');
  process.exit(1);
}

const mode = process.argv[2] ?? 'matrix';

if (mode === 'list') {
  console.log(sites.map((site) => site.site).join('\n'));
} else {
  // GitHub matrices cannot contain dots in the job name cleanly, so carry a
  // sanitised `slug` alongside the real site id for artifact names.
  console.log(
    JSON.stringify(
      sites.map((site) => ({
        site: site.site,
        slug: String(site.site).replace(/[^a-z0-9]+/gi, '-'),
        lang: site.lang ?? 'en',
        timeout: site.timeout ?? 30000,
        maxConnections: site.max_connections ?? 8,
      })),
    ),
  );
}
