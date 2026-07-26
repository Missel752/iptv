/** Filesystem helpers: atomic writes, JSON/gzip round-trips, directory utilities. */

import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/** Writes via a temp file + rename so readers never observe a partial file. */
export async function writeFileAtomic(file: string, data: string | Buffer): Promise<void> {
  await ensureDir(path.dirname(file));
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(temp, data);
  await fs.rename(temp, file);
}

export async function writeText(file: string, text: string): Promise<void> {
  await writeFileAtomic(file, text);
}

export async function writeBuffer(file: string, buffer: Buffer): Promise<void> {
  await writeFileAtomic(file, buffer);
}

export async function readText(file: string): Promise<string> {
  return fs.readFile(file, 'utf8');
}

export async function readBuffer(file: string): Promise<Buffer> {
  return fs.readFile(file);
}

export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readText(file)) as T;
}

export async function readJsonOr<T>(file: string, fallback: T): Promise<T> {
  try {
    return await readJson<T>(file);
  } catch {
    return fallback;
  }
}

export interface WriteJsonOptions {
  /** Pretty-print with 2-space indentation. Defaults to compact. */
  pretty?: boolean;
  /** Also emit a `.gz` sibling. */
  gzip?: boolean;
}

export async function writeJson<T>(
  file: string,
  data: T,
  options: WriteJsonOptions = {},
): Promise<number> {
  const text = options.pretty ? `${JSON.stringify(data, null, 2)}\n` : JSON.stringify(data);
  await writeFileAtomic(file, text);
  if (options.gzip) {
    await writeFileAtomic(`${file}.gz`, gzipSync(Buffer.from(text), { level: 9 }));
  }
  return Buffer.byteLength(text);
}

export async function writeGzip(file: string, data: string | Buffer): Promise<number> {
  const compressed = gzipSync(typeof data === 'string' ? Buffer.from(data) : data, { level: 9 });
  await writeFileAtomic(file, compressed);
  return compressed.length;
}

export async function readMaybeGzip(file: string): Promise<Buffer> {
  const buffer = await readBuffer(file);
  if (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) return gunzipSync(buffer);
  return buffer;
}

/** Recursively removes a path, ignoring a missing target. */
export async function remove(target: string): Promise<void> {
  await fs.rm(target, { recursive: true, force: true });
}

/** Copies a directory tree. */
export async function copyDir(from: string, to: string): Promise<void> {
  await ensureDir(to);
  await fs.cp(from, to, { recursive: true });
}

export async function listFiles(dir: string, extension?: string): Promise<string[]> {
  if (!(await exists(dir))) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && (!extension || entry.name.endsWith(extension)))
    .map((entry) => path.join(dir, entry.name));
}

export async function fileSize(file: string): Promise<number> {
  try {
    return (await fs.stat(file)).size;
  } catch {
    return 0;
  }
}

export function hashContent(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
