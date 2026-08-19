import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { ViewerError } from './errors.js';
import { GitRunner } from './git-runner.js';
import {
  OID_PATTERN, type Change, type CommitChanges, type CommitDetail, type CommitSummary,
  type ContentPolicy, type GitRef, type Page, type PatchResult, type PathValue,
  type RepositoryInfo, type RepositoryStatus, type WorktreeInfo,
} from '../schema/types.js';

const utf8Fatal = new TextDecoder('utf-8', { fatal: true });
const MAX_COMMITS = 500;
const MAX_PATCH_BYTES = 200 * 1024;
const MAX_BODY_BYTES = 256 * 1024;

function trimLine(value: string): string { return value.replace(/[\r\n]+$/u, ''); }
function splitNul(buffer: Buffer): Buffer[] {
  const values: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0) { values.push(buffer.subarray(start, index)); start = index + 1; }
  }
  if (start < buffer.length) values.push(buffer.subarray(start));
  while (values.at(-1)?.length === 0) values.pop();
  return values;
}
function pathValue(buffer: Buffer): PathValue {
  try { return { display: utf8Fatal.decode(buffer), encoding: 'utf8', rawBase64: null }; }
  catch { return { display: buffer.toString('utf8'), encoding: 'base64', rawBase64: buffer.toString('base64') }; }
}
function safeLimit(value: number, maximum = 200, fallback = 50): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new ViewerError('INVALID_ARGUMENT', `Limit must be between 1 and ${maximum}.`);
  return value || fallback;
}

function parseStatus(buffer: Buffer, includePaths: boolean): RepositoryStatus {
  const records = splitNul(buffer).map((item) => item.toString('utf8'));
  const files: Array<{ path: PathValue; state: string }> = [];
  const result: RepositoryStatus = {
    head: null, branch: null, upstream: null, ahead: 0, behind: 0,
    staged: 0, modified: 0, untracked: 0, conflicted: 0,
    files: includePaths ? files : null, filesTruncated: false, omittedFileCount: 0,
  };
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? '';
    if (record.startsWith('# branch.oid ')) result.head = record.slice(13) === '(initial)' ? null : record.slice(13);
    else if (record.startsWith('# branch.head ')) result.branch = record.slice(14) === '(detached)' ? null : record.slice(14);
    else if (record.startsWith('# branch.upstream ')) result.upstream = record.slice(18);
    else if (record.startsWith('# branch.ab ')) {
      const match = record.match(/\+(\d+) -(\d+)/u);
      if (match) { result.ahead = Number(match[1]); result.behind = Number(match[2]); }
    } else if (record.startsWith('? ')) {
      result.untracked += 1;
      if (includePaths && files.length < 2_000) files.push({ path: pathValue(Buffer.from(record.slice(2))), state: '??' });
      else if (includePaths) result.omittedFileCount += 1;
    } else if (record.startsWith('u ')) {
      result.conflicted += 1;
      const parts = record.split(' ');
      const name = parts.slice(10).join(' ');
      if (includePaths && files.length < 2_000) files.push({ path: pathValue(Buffer.from(name)), state: parts[1] ?? 'UU' });
      else if (includePaths) result.omittedFileCount += 1;
    } else if (record.startsWith('1 ') || record.startsWith('2 ')) {
      const parts = record.split(' ');
      const state = parts[1] ?? '..';
      const name = parts.slice(record.startsWith('2 ') ? 10 : 9).join(' ');
      if (state[0] !== '.') result.staged += 1;
      if (state[1] !== '.') result.modified += 1;
      if (includePaths && files.length < 2_000) files.push({ path: pathValue(Buffer.from(name)), state });
      else if (includePaths) result.omittedFileCount += 1;
      if (record.startsWith('2 ')) index += 1;
    }
  }
  result.filesTruncated = result.omittedFileCount > 0;
  return result;
}

function parseRefs(buffer: Buffer): GitRef[] {
  return buffer.toString('utf8').split('\n').filter(Boolean).slice(0, 5_000).map((line) => {
    const [objectOid = '', objectType = '', peeledOid = '', peeledType = '', fullName = '', upstream = '', head = ''] = line.split('\t');
    const kind: GitRef['kind'] = fullName.startsWith('refs/heads/') ? 'local' : fullName.startsWith('refs/remotes/') ? 'remote' : 'tag';
    const peeledCommitOid = objectType === 'commit' ? objectOid : peeledType === 'commit' ? peeledOid : null;
    return {
      name: fullName.replace(/^refs\/(?:heads|remotes|tags)\//u, ''), fullName,
      kind, objectOid, peeledCommitOid, upstream: upstream || null, current: head.trim() === '*',
    };
  }).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

function parseGraph(buffer: Buffer, refs: GitRef[], unpushed: Set<string>): CommitSummary[] {
  const fields = splitNul(buffer).map((item) => item.toString('utf8'));
  const byOid = new Map<string, GitRef[]>();
  for (const ref of refs) {
    if (!ref.peeledCommitOid) continue;
    const list = byOid.get(ref.peeledCommitOid) ?? [];
    list.push(ref); byOid.set(ref.peeledCommitOid, list);
  }
  const commits: CommitSummary[] = [];
  for (let index = 0; index + 4 < fields.length; index += 5) {
    const oid = fields[index] ?? '';
    commits.push({
      oid, parents: fields[index + 1] ? (fields[index + 1] ?? '').split(' ') : [],
      authorName: fields[index + 2] ?? '', authoredAt: fields[index + 3] ?? '',
      subject: trimLine(fields[index + 4] ?? ''), refs: byOid.get(oid) ?? [], unpushed: unpushed.has(oid),
    });
  }
  return commits;
}

function parseChanges(nameStatus: Buffer, numstat: Buffer, includePaths: boolean): Change[] {
  const names = splitNul(nameStatus);
  const stats = new Map<string, { added: number | null; deleted: number | null }>();
  for (const record of splitNul(numstat)) {
    const text = record.toString('utf8');
    const match = text.match(/^(\d+|-)\t(\d+|-)\t(.*)$/su);
    if (match) stats.set(match[3] ?? '', { added: match[1] === '-' ? null : Number(match[1]), deleted: match[2] === '-' ? null : Number(match[2]) });
  }
  const result: Change[] = [];
  for (let index = 0; index + 1 < names.length && result.length < 1_000;) {
    const state = names[index]?.toString('ascii') ?? '';
    if (/^[RC]\d+$/u.test(state) && index + 2 < names.length) {
      const old = names[index + 1] ?? Buffer.alloc(0); const current = names[index + 2] ?? Buffer.alloc(0);
      const stat = stats.get(current.toString('utf8')) ?? { added: null, deleted: null };
      result.push({ state, oldPath: includePaths ? pathValue(old) : null, path: includePaths ? pathValue(current) : null, ...stat });
      index += 3;
    } else {
      const current = names[index + 1] ?? Buffer.alloc(0);
      const stat = stats.get(current.toString('utf8')) ?? { added: null, deleted: null };
      result.push({ state, oldPath: null, path: includePaths ? pathValue(current) : null, ...stat });
      index += 2;
    }
  }
  return result;
}

export interface RepositoryOptions { contentPolicy?: ContentPolicy; excludePaths?: string[]; timeoutMs?: number; outputLimit?: number }

export class RepositoryReader {
  readonly root: string;
  readonly policy: ContentPolicy;
  readonly excludes: string[];
  private readonly git: GitRunner;
  private readonly cursorSecret = randomBytes(32);
  private commitSnapshot: { generation: string; values: CommitSummary[] } | null = null;
  private commitSnapshotPending: { generation: string; promise: Promise<CommitSummary[]>; token: symbol } | null = null;

  private constructor(root: string, options: RepositoryOptions) {
    this.root = root; this.policy = options.contentPolicy ?? 'metadata'; this.excludes = options.excludePaths ?? [];
    this.git = new GitRunner(root, options.timeoutMs, options.outputLimit);
  }

  static async open(repoInput: string, options: RepositoryOptions = {}): Promise<RepositoryReader> {
    let requested: string;
    try { requested = await realpath(repoInput); }
    catch (error) { throw new ViewerError('NOT_GIT_REPOSITORY', 'Repository path does not exist.', { cause: error }); }
    const probe = new GitRunner(requested, options.timeoutMs, options.outputLimit);
    const rootResult = await probe.run('repoInfo', ['rev-parse', '--show-toplevel'], true);
    if (rootResult.code !== 0) throw new ViewerError('NOT_GIT_REPOSITORY', 'Path is not inside a Git worktree.');
    const root = await realpath(trimLine(rootResult.stdout.toString('utf8')));
    return new RepositoryReader(root, options);
  }

  async generation(): Promise<string> {
    const outputs = await Promise.all([
      this.git.run('head', ['rev-parse', '--verify', 'HEAD'], true),
      this.git.run('refs', ['for-each-ref', '--format=%(objectname)%00%(refname)', 'refs/heads', 'refs/remotes', 'refs/tags']),
      this.git.run('status', ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal']),
      this.git.run('worktrees', ['worktree', 'list', '--porcelain', '-z']),
    ]);
    const hash = createHash('sha256'); for (const output of outputs) hash.update(output.stdout); return hash.digest('hex');
  }

  async refs(): Promise<GitRef[]> {
    const result = await this.git.run('refs', ['for-each-ref', '--format=%(objectname)%09%(objecttype)%09%(*objectname)%09%(*objecttype)%09%(refname)%09%(upstream:short)%09%(HEAD)', 'refs/heads', 'refs/remotes', 'refs/tags']);
    return parseRefs(result.stdout);
  }

  async status(includePaths = true): Promise<RepositoryStatus> {
    return parseStatus((await this.git.run('status', ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal'])).stdout, includePaths);
  }

  async repository(): Promise<RepositoryInfo> {
    const status = await this.status(false);
    const format = trimLine((await this.git.run('repoInfo', ['rev-parse', '--show-object-format'])).stdout.toString('utf8')) as 'sha1' | 'sha256';
    return {
      name: path.basename(this.root), objectFormat: format, head: status.head, branch: status.branch,
      detached: status.head !== null && status.branch === null, unborn: status.head === null,
      capabilities: { patchPolicy: this.policy, maxCommits: MAX_COMMITS, maxPatchBytes: MAX_PATCH_BYTES },
    };
  }

  private async unpushedSet(): Promise<Set<string>> {
    const result = await this.git.run('unpushed', ['rev-list', '--branches', '--not', '--remotes'], true);
    return new Set(result.code === 0 ? result.stdout.toString('utf8').split('\n').filter((oid) => OID_PATTERN.test(oid)) : []);
  }

  private async commitValues(generation: string): Promise<CommitSummary[]> {
    if (this.commitSnapshot?.generation === generation) return this.commitSnapshot.values;
    if (this.commitSnapshotPending?.generation === generation) return this.commitSnapshotPending.promise;

    const token = Symbol('commit-snapshot');
    const promise = (async () => {
      const refs = await this.refs();
      const unpushed = await this.unpushedSet();
      const result = await this.git.run('graph', ['log', '--branches', '--remotes', '--tags', 'HEAD', '--topo-order', '--date-order', '-z', `--max-count=${MAX_COMMITS}`, '--format=%H%x00%P%x00%an%x00%aI%x00%s'], true);
      const values = result.code === 0 ? parseGraph(result.stdout, refs, unpushed) : [];
      if (this.commitSnapshotPending?.token === token) this.commitSnapshot = { generation, values };
      return values;
    })();
    this.commitSnapshotPending = { generation, promise, token };
    try { return await promise; }
    finally {
      if (this.commitSnapshotPending?.token === token) this.commitSnapshotPending = null;
    }
  }

  private encodeCursor(operation: string, generation: string, offset: number): string {
    const payload = Buffer.from(JSON.stringify({ version: 1, generation, operation, offset, filterHash: 'v1:all' })).toString('base64url');
    const signature = createHmac('sha256', this.cursorSecret).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }

  private decodeCursor(cursor: string | null, operation: string, generation: string): number {
    if (cursor === null) return 0;
    const [payload = '', signature = ''] = cursor.split('.');
    const expected = createHmac('sha256', this.cursorSecret).update(payload).digest('base64url');
    const a = Buffer.from(signature); const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new ViewerError('INVALID_ARGUMENT', 'Cursor signature is invalid.');
    let value: { version?: number; generation?: string; operation?: string; offset?: number; filterHash?: string };
    try { value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as typeof value; }
    catch { throw new ViewerError('INVALID_ARGUMENT', 'Cursor payload is invalid.'); }
    if (value.version !== 1 || value.operation !== operation || value.filterHash !== 'v1:all' || !Number.isInteger(value.offset) || (value.offset ?? -1) < 0) throw new ViewerError('INVALID_ARGUMENT', 'Cursor does not match this operation.');
    if (value.generation !== generation) throw new ViewerError('STALE_CURSOR', 'Repository state changed after this cursor was issued.');
    return value.offset ?? 0;
  }

  async commits(limit = 50, cursor: string | null = null): Promise<Page<CommitSummary>> {
    safeLimit(limit);
    const generation = await this.generation(); const offset = this.decodeCursor(cursor, 'commits', generation);
    const values = await this.commitValues(generation);
    const end = Math.min(values.length, offset + limit); const truncated = end < values.length;
    return { items: values.slice(offset, end), truncated, omittedCount: truncated ? (values.length === MAX_COMMITS ? null : values.length - end) : 0, nextCursor: truncated ? this.encodeCursor('commits', generation, end) : null };
  }

  async unpushed(limit = 50): Promise<Page<CommitSummary>> {
    const page = await this.commits(Math.min(MAX_COMMITS, Math.max(limit, 1)));
    const items = page.items.filter((item) => item.unpushed).slice(0, safeLimit(limit));
    return { items, truncated: false, omittedCount: 0, nextCursor: null };
  }

  private validateOid(oid: string): void {
    if (!OID_PATTERN.test(oid)) throw new ViewerError('INVALID_OID', 'A complete lowercase commit object ID is required.');
  }

  private async authorize(oid: string): Promise<void> {
    this.validateOid(oid);
    const type = await this.git.run('authorizeCommit', ['cat-file', '-e', `${oid}^{commit}`], true);
    if (type.code !== 0) throw new ViewerError('NOT_FOUND', 'Commit not found.');
    const refs = await this.git.run('authorizeCommit', ['for-each-ref', `--contains=${oid}`, '--format=%(refname)', 'refs/heads', 'refs/remotes', 'refs/tags']);
    if (refs.stdout.length > 0) return;
    const head = await this.git.run('authorizeCommit', ['merge-base', '--is-ancestor', oid, 'HEAD'], true);
    if (head.code !== 0) throw new ViewerError('NOT_FOUND', 'Commit is not reachable from visible repository history.');
  }

  async commit(oid: string): Promise<CommitDetail> {
    await this.authorize(oid);
    const meta = await this.git.run('commitMeta', ['show', '-s', '-z', '--format=%H%x00%P%x00%an%x00%aI%x00%cn%x00%cI%x00%B', oid, '--']);
    const fields = splitNul(meta.stdout);
    const rawBody = Buffer.concat(fields.slice(6));
    const body = rawBody.subarray(0, MAX_BODY_BYTES).toString('utf8').trimEnd();
    const [refs, unpushed] = await Promise.all([this.refs(), this.unpushedSet()]);
    const summary: CommitSummary = {
      oid, parents: (fields[1]?.toString('utf8') || '').split(' ').filter(Boolean), authorName: fields[2]?.toString('utf8') ?? '',
      authoredAt: fields[3]?.toString('utf8') ?? '', subject: body.split('\n')[0] ?? '',
      refs: refs.filter((item) => item.peeledCommitOid === oid), unpushed: unpushed.has(oid),
    };
    return {
      ...summary, body, bodyOriginalBytes: rawBody.length, bodyTruncated: rawBody.length > MAX_BODY_BYTES,
      committerName: fields[4]?.toString('utf8') ?? '', committedAt: fields[5]?.toString('utf8') ?? '',
    };
  }

  private async parent(oid: string, requested: number | null): Promise<{ parents: string[]; parentIndex: number | null; parentOid: string | null }> {
    await this.authorize(oid);
    const parentLine = trimLine((await this.git.run('commitMeta', ['show', '-s', '--format=%P', oid, '--'])).stdout.toString('utf8'));
    const parents = parentLine ? parentLine.split(' ') : [];
    if (parents.length === 0) {
      if (requested !== null) throw new ViewerError('INVALID_ARGUMENT', 'Root commits do not have a parent index.');
      return { parents: [], parentIndex: null, parentOid: null };
    }
    const parentIndex = requested ?? 0;
    if (!Number.isInteger(parentIndex) || parentIndex < 0 || parentIndex >= parents.length) throw new ViewerError('INVALID_ARGUMENT', 'Parent index is out of range.');
    return { parents, parentIndex, parentOid: parents[parentIndex] ?? null };
  }

  async changes(oid: string, parentIndex: number | null = null, includePaths = true): Promise<CommitChanges> {
    const parent = await this.parent(oid, parentIndex);
    const base = parent.parentOid ? [parent.parentOid, oid] : ['--root', oid];
    const fixed = ['diff-tree', '--no-commit-id', '-r', '-z', '-M', '--no-ext-diff', '--submodule=short'];
    const names = await this.git.run('commitChanges', [...fixed, '--name-status', ...base, '--']);
    const stats = await this.git.run('commitChanges', [...fixed, '--numstat', ...base, '--']);
    const changes = parseChanges(names.stdout, stats.stdout, includePaths);
    return { oid, parentIndex: parent.parentIndex, parentOid: parent.parentOid, changes, pathsIncluded: includePaths, truncated: false, omittedCount: 0 };
  }

  async worktrees(): Promise<Page<WorktreeInfo>> {
    const records = splitNul((await this.git.run('worktrees', ['worktree', 'list', '--porcelain', '-z'])).stdout).map((item) => item.toString('utf8'));
    const items: WorktreeInfo[] = []; let current: WorktreeInfo | null = null; let rawPath = '';
    for (const record of records) {
      if (record.startsWith('worktree ')) {
        if (current) items.push(current);
        rawPath = record.slice(9);
        current = { id: createHash('sha256').update(rawPath).digest('hex').slice(0, 16), displayName: path.basename(rawPath), head: null, branch: null, detached: false, current: path.resolve(rawPath) === this.root, locked: false, prunable: false };
      } else if (current && record.startsWith('HEAD ')) current.head = record.slice(5);
      else if (current && record.startsWith('branch ')) current.branch = record.slice(7).replace(/^refs\/heads\//u, '');
      else if (current && record === 'detached') current.detached = true;
      else if (current && record.startsWith('locked')) current.locked = true;
      else if (current && record.startsWith('prunable')) current.prunable = true;
    }
    if (current) items.push(current);
    items.sort((a, b) => Number(b.current) - Number(a.current) || a.displayName.localeCompare(b.displayName));
    return { items: items.slice(0, 1_000), truncated: items.length > 1_000, omittedCount: Math.max(0, items.length - 1_000), nextCursor: null };
  }

  async patch(oid: string, parentIndex: number | null, requestedPaths: string[], contextLines: number): Promise<PatchResult> {
    if (this.policy === 'metadata') throw new ViewerError('CONTENT_DISABLED', 'Patch access is disabled by the metadata policy.');
    if (!Number.isInteger(contextLines) || contextLines < 0 || contextLines > 10) throw new ViewerError('INVALID_ARGUMENT', 'Context lines must be between 0 and 10.');
    const detail = await this.changes(oid, parentIndex, true); const eligible = new Map<string, Change>();
    const excludedPaths: Array<{ path: PathValue; reason: string }> = [];
    for (const item of detail.changes) {
      for (const value of [item.path, item.oldPath]) if (value?.encoding === 'utf8') eligible.set(value.display, item);
      for (const value of [item.path, item.oldPath]) if (value?.encoding === 'base64') excludedPaths.push({ path: value, reason: 'UNSUPPORTED_PATH_ENCODING' });
    }
    const chosen = requestedPaths.length === 0 ? [...new Set([...eligible.values()])] : requestedPaths.map((value) => {
      const found = eligible.get(value); if (!found) throw new ViewerError('CONTENT_EXCLUDED', 'Requested path is not an eligible changed path.'); return found;
    });
    const paths = [...new Set(chosen.flatMap((item) => [item.path, item.oldPath]).filter((value): value is PathValue => value?.encoding === 'utf8').map((value) => value.display))];
    const isBuiltInExcluded = (value: string): boolean => {
      const parts = value.split('/'); const base = parts.at(-1) ?? '';
      return (this.policy === 'redacted' && (base.startsWith('.env') || base.startsWith('id_rsa') || base.endsWith('.pem') || base.endsWith('.key') || ['.npmrc', '.pypirc', '.netrc'].includes(base) || parts.some((item) => ['.aws', '.ssh'].includes(item)) || /credential|secret/iu.test(base))) || this.excludes.some((prefix) => value === prefix || value.startsWith(`${prefix}/`));
    };
    const included = paths.filter((value) => !isBuiltInExcluded(value));
    for (const value of paths.filter(isBuiltInExcluded)) excludedPaths.push({ path: pathValue(Buffer.from(value)), reason: 'PATH_EXCLUDED' });
    const parent = await this.parent(oid, parentIndex);
    const patchArgs = parent.parentOid
      ? ['diff', `--unified=${contextLines}`, '--no-ext-diff', '--no-textconv', '--submodule=short', parent.parentOid, oid, '--', ...included]
      : ['show', '--format=', '--root', `--unified=${contextLines}`, '--no-ext-diff', '--no-textconv', '--submodule=short', oid, '--', ...included];
    const result = included.length === 0 ? Buffer.alloc(0) : (await this.git.run('commitPatch', patchArgs)).stdout;
    let text = result.subarray(0, MAX_PATCH_BYTES).toString('utf8');
    if (this.policy === 'redacted') text = text.replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/gu, '[REDACTED PRIVATE KEY]').replace(/\b(?:ghp_|github_pat_|sk-)[A-Za-z0-9_-]{16,}\b/gu, '[REDACTED TOKEN]');
    return { oid, parentIndex: parent.parentIndex, parentOid: parent.parentOid, policy: this.policy, text, includedPaths: included.map((value) => pathValue(Buffer.from(value))), excludedPaths, byteCount: result.length, truncated: result.length > MAX_PATCH_BYTES };
  }
}

export async function openRepository(repo: string, options: RepositoryOptions = {}): Promise<RepositoryReader> {
  return RepositoryReader.open(repo, options);
}
