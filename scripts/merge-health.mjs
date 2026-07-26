#!/usr/bin/env node
/**
 * Merges health databases produced by parallel scan shards.
 *
 * Each shard checks a disjoint subset of streams but starts from the same
 * baseline, so for every stream key we keep the record with the newest
 * `checked_at` — that is the shard that actually probed it.
 *
 * Usage: node scripts/merge-health.mjs <shard-dir> <output.json>
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

const [, , shardDir = 'shards', output = '.data/health.json'] = process.argv;

async function findJsonFiles(dir) {
  const found = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await findJsonFiles(full)));
    else if (entry.name.endsWith('.json')) found.push(full);
  }
  return found;
}

const files = await findJsonFiles(shardDir);
if (files.length === 0) {
  console.error(`No shard files found under ${shardDir}`);
  process.exit(1);
}

const merged = new Map();
let read = 0;

for (const file of files) {
  let records;
  try {
    records = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    console.warn(`Skipping ${file}: ${error.message}`);
    continue;
  }
  if (!Array.isArray(records)) continue;

  for (const record of records) {
    if (!record?.key) continue;
    read++;
    const existing = merged.get(record.key);
    if (!existing) {
      merged.set(record.key, record);
      continue;
    }
    const existingAt = Date.parse(existing.checked_at ?? 0) || 0;
    const candidateAt = Date.parse(record.checked_at ?? 0) || 0;
    // Newer check wins; ties go to the record with more accumulated history.
    if (
      candidateAt > existingAt ||
      (candidateAt === existingAt && (record.checks ?? 0) > (existing.checks ?? 0))
    ) {
      merged.set(record.key, record);
    }
  }
}

await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, JSON.stringify([...merged.values()]));

const online = [...merged.values()].filter((record) => record.status === 'online').length;
console.log(
  `Merged ${files.length} shard file(s): ${read} records read → ${merged.size} unique ` +
    `(${online} online)`,
);
