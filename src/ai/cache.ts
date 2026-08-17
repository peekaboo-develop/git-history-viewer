import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir, platform as hostPlatform } from 'node:os';
import path from 'node:path';
import { ViewerError } from '../core/errors.js';

const CACHE_SCHEMA_VERSION = 1 as const;
const KEY_PATTERN = /^[0-9a-f]{64}$/u;
const SHARD_PATTERN = /^[0-9a-f]{2}$/u;
const CACHE_FILE_PATTERN = /^[0-9a-f]{64}\.json$/u;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_MAX_RECORD_BYTES = 128 * 1024;
const DEFAULT_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export type AiOperation = 'translate' | 'explain' | 'review';

export interface AiCacheRequest {
  operation: AiOperation;
  targetLanguage: string;
  promptVersion: string;
  provider: string;
  model: string;
  exactInputDigest: string;
}

export interface AiCacheRecord<T = unknown> {
  schemaVersion: 1;
  key: string;
  createdAt: string;
  operation: AiOperation;
  targetLanguage: string;
  promptVersion: string;
  provider: string;
  model: string;
  result: T;
}

export interface AiCacheStats {
  entries: number;
  bytes: number;
  oldestModifiedAt: string | null;
  newestModifiedAt: string | null;
}

export interface AiCacheLimits {
  maxBytes?: number;
  maxEntries?: number;
  maxRecordBytes?: number;
  pruneIntervalMs?: number;
}

export interface AiCacheLookup<T> { key: string; value: T; cacheHit: boolean }

function validateLabel(value: string, field: string): void {
  if (!value || value.length > 160 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ViewerError('INVALID_ARGUMENT', `${field} must be a non-empty printable value of at most 160 characters.`);
  }
}

function validateRequest(request: AiCacheRequest): void {
  if (!['translate', 'explain', 'review'].includes(request.operation)) throw new ViewerError('INVALID_ARGUMENT', 'Unknown AI cache operation.');
  validateLabel(request.targetLanguage, 'targetLanguage');
  validateLabel(request.promptVersion, 'promptVersion');
  validateLabel(request.provider, 'provider');
  validateLabel(request.model, 'model');
  if (!KEY_PATTERN.test(request.exactInputDigest)) throw new ViewerError('INVALID_ARGUMENT', 'exactInputDigest must be a lowercase SHA-256 digest.');
}

export function digestAiInput(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function aiCacheKey(request: AiCacheRequest): string {
  validateRequest(request);
  const canonical = JSON.stringify({
    schemaVersion: CACHE_SCHEMA_VERSION,
    operation: request.operation,
    targetLanguage: request.targetLanguage,
    promptVersion: request.promptVersion,
    provider: request.provider,
    model: request.model,
    exactInputDigest: request.exactInputDigest,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function defaultAiCacheRoot(
  currentPlatform = hostPlatform(),
  environment: Readonly<Record<string, string | undefined>> = process.env,
  userHome = homedir(),
): string {
  if (currentPlatform === 'darwin') return path.join(userHome, 'Library', 'Caches', 'git-history-viewer', 'ai', 'v1');
  if (currentPlatform === 'win32') {
    const local = environment.LOCALAPPDATA;
    const base = local && path.win32.isAbsolute(local) ? local : path.win32.join(userHome, 'AppData', 'Local');
    return path.win32.join(base, 'git-history-viewer', 'Cache', 'ai', 'v1');
  }
  const xdg = environment.XDG_CACHE_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(userHome, '.cache');
  return path.join(base, 'git-history-viewer', 'ai', 'v1');
}

function cacheFailure(message: string, cause: unknown): ViewerError {
  return new ViewerError('CACHE_FAILED', message, { cause });
}

function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

function assertJsonValue(value: unknown, seen = new WeakSet<object>(), depth = 0): void {
  if (depth > 64) throw new ViewerError('INVALID_ARGUMENT', 'AI cache result exceeds the maximum nesting depth.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ViewerError('INVALID_ARGUMENT', 'AI cache result contains a non-finite number.');
    return;
  }
  if (typeof value !== 'object') throw new ViewerError('INVALID_ARGUMENT', 'AI cache result must contain only JSON values.');
  if (seen.has(value)) throw new ViewerError('INVALID_ARGUMENT', 'AI cache result contains a cycle.');
  seen.add(value);
  if (Array.isArray(value)) for (const item of value) assertJsonValue(item, seen, depth + 1);
  else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new ViewerError('INVALID_ARGUMENT', 'AI cache result must contain only plain objects.');
    for (const item of Object.values(value as Record<string, unknown>)) assertJsonValue(item, seen, depth + 1);
  }
  seen.delete(value);
}

function parseRecord<T>(raw: Buffer, expectedKey: string): AiCacheRecord<T> | null {
  let value: unknown;
  try { value = JSON.parse(raw.toString('utf8')); } catch { return null; }
  if (!isRecord(value) || value.schemaVersion !== CACHE_SCHEMA_VERSION || value.key !== expectedKey || typeof value.createdAt !== 'string') return null;
  if (!['translate', 'explain', 'review'].includes(String(value.operation)) || typeof value.targetLanguage !== 'string' || typeof value.promptVersion !== 'string' || typeof value.provider !== 'string' || typeof value.model !== 'string' || !Object.hasOwn(value, 'result')) return null;
  if (!Number.isFinite(Date.parse(value.createdAt))) return null;
  return value as unknown as AiCacheRecord<T>;
}

async function ensureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new ViewerError('CACHE_FAILED', 'AI cache directory must be a real directory.');
  if (process.platform !== 'win32') await chmod(directory, 0o700);
}

export class FileAiCache {
  readonly root: string;
  readonly maxBytes: number;
  readonly maxEntries: number;
  readonly maxRecordBytes: number;
  readonly pruneIntervalMs: number;
  private readonly inflight = new Map<string, Promise<AiCacheLookup<unknown>>>();
  private lastPrunedAt = 0;

  constructor(root = defaultAiCacheRoot(), limits: AiCacheLimits = {}) {
    this.root = path.resolve(root);
    this.maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxEntries = limits.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxRecordBytes = limits.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
    this.pruneIntervalMs = limits.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
    for (const [name, value] of Object.entries({ maxBytes: this.maxBytes, maxEntries: this.maxEntries, maxRecordBytes: this.maxRecordBytes, pruneIntervalMs: this.pruneIntervalMs })) {
      if (!Number.isSafeInteger(value) || value < 0) throw new ViewerError('INVALID_ARGUMENT', `${name} must be a non-negative safe integer.`);
    }
  }

  private file(key: string): string {
    if (!KEY_PATTERN.test(key)) throw new ViewerError('INVALID_ARGUMENT', 'AI cache key must be a lowercase SHA-256 digest.');
    return path.join(this.root, key.slice(0, 2), `${key}.json`);
  }

  async get<T>(key: string): Promise<AiCacheRecord<T> | null> {
    const filename = this.file(key);
    try {
      const info = await lstat(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.size > this.maxRecordBytes) return null;
      return parseRecord<T>(await readFile(filename), key);
    } catch (error) {
      if (isMissing(error)) return null;
      throw cacheFailure('AI cache entry could not be read.', error);
    }
  }

  async put<T>(request: AiCacheRequest, result: T): Promise<AiCacheRecord<T>> {
    const key = aiCacheKey(request);
    assertJsonValue(result);
    const record: AiCacheRecord<T> = { schemaVersion: CACHE_SCHEMA_VERSION, key, createdAt: new Date().toISOString(), operation: request.operation, targetLanguage: request.targetLanguage, promptVersion: request.promptVersion, provider: request.provider, model: request.model, result };
    let payload: Buffer;
    try { payload = Buffer.from(`${JSON.stringify(record)}\n`); } catch (error) { throw new ViewerError('INVALID_ARGUMENT', 'AI cache result must be JSON serializable.', { cause: error }); }
    if (payload.length > this.maxRecordBytes) throw new ViewerError('OUTPUT_LIMIT', `AI cache entry exceeds ${this.maxRecordBytes} bytes.`);
    const filename = this.file(key); const shard = path.dirname(filename);
    try {
      await ensureDirectory(this.root); await ensureDirectory(shard);
      const temporary = path.join(shard, `.${key}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
      try {
        await writeFile(temporary, payload, { flag: 'wx', mode: 0o600, flush: true });
        await rename(temporary, filename);
        if (process.platform !== 'win32') await chmod(filename, 0o600);
      } finally { await rm(temporary, { force: true }); }
    } catch (error) { throw cacheFailure('AI cache entry could not be written.', error); }
    await this.pruneIfDue();
    return record;
  }

  async getOrCompute<T>(request: AiCacheRequest, compute: () => Promise<T>): Promise<AiCacheLookup<T>> {
    const key = aiCacheKey(request); const cached = await this.get<T>(key);
    if (cached) return { key, value: cached.result, cacheHit: true };
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<AiCacheLookup<T>>;
    const pending = (async (): Promise<AiCacheLookup<T>> => {
      const secondCheck = await this.get<T>(key);
      if (secondCheck) return { key, value: secondCheck.result, cacheHit: true };
      const value = await compute(); await this.put(request, value); return { key, value, cacheHit: false };
    })();
    this.inflight.set(key, pending as Promise<AiCacheLookup<unknown>>);
    try { return await pending; } finally { this.inflight.delete(key); }
  }

  private async entries(): Promise<Array<{ filename: string; bytes: number; modifiedMs: number }>> {
    const entries: Array<{ filename: string; bytes: number; modifiedMs: number }> = [];
    try {
      const root = await lstat(this.root);
      if (!root.isDirectory() || root.isSymbolicLink()) throw new ViewerError('CACHE_FAILED', 'AI cache directory must be a real directory.');
    } catch (error) {
      if (isMissing(error)) return entries;
      if (error instanceof ViewerError) throw error;
      throw cacheFailure('AI cache directory could not be inspected.', error);
    }
    let shards;
    try { shards = await readdir(this.root, { withFileTypes: true }); } catch (error) { if (isMissing(error)) return entries; throw cacheFailure('AI cache directory could not be listed.', error); }
    for (const shard of shards) {
      if (!shard.isDirectory() || shard.isSymbolicLink() || !SHARD_PATTERN.test(shard.name)) continue;
      const directory = path.join(this.root, shard.name); let files;
      try { files = await readdir(directory, { withFileTypes: true }); } catch { continue; }
      for (const file of files) {
        if (!file.isFile() || file.isSymbolicLink() || !CACHE_FILE_PATTERN.test(file.name)) continue;
        const filename = path.join(directory, file.name);
        try { const info = await stat(filename); entries.push({ filename, bytes: info.size, modifiedMs: info.mtimeMs }); } catch { /* Concurrent cleanup is a cache miss. */ }
      }
    }
    return entries;
  }

  async stats(): Promise<AiCacheStats> {
    const entries = await this.entries();
    const times = entries.map((entry) => entry.modifiedMs).filter(Number.isFinite);
    return { entries: entries.length, bytes: entries.reduce((total, entry) => total + entry.bytes, 0), oldestModifiedAt: times.length ? new Date(Math.min(...times)).toISOString() : null, newestModifiedAt: times.length ? new Date(Math.max(...times)).toISOString() : null };
  }

  async prune(): Promise<{ removedEntries: number; removedBytes: number }> {
    const entries = (await this.entries()).sort((left, right) => left.modifiedMs - right.modifiedMs);
    let count = entries.length; let bytes = entries.reduce((total, entry) => total + entry.bytes, 0); let removedEntries = 0; let removedBytes = 0;
    for (const entry of entries) {
      if (count <= this.maxEntries && bytes <= this.maxBytes) break;
      try { await unlink(entry.filename); count -= 1; bytes -= entry.bytes; removedEntries += 1; removedBytes += entry.bytes; } catch (error) { if (!isMissing(error)) throw cacheFailure('AI cache entry could not be pruned.', error); }
    }
    this.lastPrunedAt = Date.now(); return { removedEntries, removedBytes };
  }

  private async pruneIfDue(): Promise<void> {
    if (Date.now() - this.lastPrunedAt < this.pruneIntervalMs) return;
    await this.prune();
  }

  async clear(): Promise<{ removedEntries: number; removedBytes: number }> {
    const entries = await this.entries(); let removedEntries = 0; let removedBytes = 0;
    for (const entry of entries) {
      try { await unlink(entry.filename); removedEntries += 1; removedBytes += entry.bytes; } catch (error) { if (!isMissing(error)) throw cacheFailure('AI cache entry could not be cleared.', error); }
    }
    this.inflight.clear(); return { removedEntries, removedBytes };
  }
}
