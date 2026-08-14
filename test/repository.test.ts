import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import test from 'node:test';
import { openRepository } from '../src/core/repository.js';
import { fixture } from './fixture.js';

test('core models refs, status, commits, and first-parent merge changes', async () => {
  const data = await fixture(); const reader = await openRepository(data.repo);
  const repo = await reader.repository(); const page = await reader.commits(100); const changes = await reader.changes(data.merge);
  assert.equal(repo.branch, 'main'); assert.equal(repo.objectFormat, 'sha1');
  assert.ok(page.items.some((item) => item.oid === data.merge && item.parents.length === 2));
  assert.ok(changes.changes.some((item) => item.path?.display === 'feature.txt'), 'merge must compare with first parent');
  assert.equal(changes.parentIndex, 0);
  const refs = await reader.refs(); const tag = refs.find((item) => item.name === 'v1');
  assert.ok(tag); assert.notEqual(tag.objectOid, tag.peeledCommitOid);
});

test('root changes compare with empty tree and hostile text stays data', async () => {
  const data = await fixture(); const reader = await openRepository(data.repo);
  const root = await reader.changes(data.root); const unsafe = await reader.commit(data.unsafe);
  assert.equal(root.parentIndex, null); assert.equal(root.parentOid, null); assert.ok(root.changes.some((item) => item.path?.display === 'root.txt'));
  assert.match(unsafe.body, /<script>alert\(1\)<\/script>/u); await assert.rejects(() => reader.changes(data.root, 0), /do not have a parent/u);
});

test('unreachable commits and option-looking revisions are rejected', async () => {
  const data = await fixture(); const reader = await openRepository(data.repo);
  await assert.rejects(() => reader.commit(data.dangling), (error: unknown) => (error as { code?: string }).code === 'NOT_FOUND');
  await assert.rejects(() => reader.commit('HEAD'), (error: unknown) => (error as { code?: string }).code === 'INVALID_OID');
  await assert.rejects(() => reader.commit('--help'), (error: unknown) => (error as { code?: string }).code === 'INVALID_OID');
});

test('topological cursors resume by offset and reject stale state', async () => {
  const data = await fixture(); const reader = await openRepository(data.repo);
  const first = await reader.commits(2); assert.ok(first.nextCursor); const second = await reader.commits(2, first.nextCursor);
  assert.equal(new Set([...first.items, ...second.items].map((item) => item.oid)).size, first.items.length + second.items.length);
  const { writeFile } = await import('node:fs/promises'); await writeFile(`${data.repo}/cursor-change.txt`, 'changed\n');
  await assert.rejects(() => reader.commits(2, first.nextCursor), (error: unknown) => (error as { code?: string }).code === 'STALE_CURSOR');
});

test('inherited Git repository overrides are not trusted', async () => {
  const data = await fixture(); const previous = process.env.GIT_DIR; process.env.GIT_DIR = pathToBogus(data.base);
  try { assert.equal((await openRepository(data.repo)).root, await realpath(data.repo)); } finally { if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous; }
});

function pathToBogus(base: string): string { return `${base}/does-not-exist`; }

test('patch tool is policy-gated and redacts excluded paths', async () => {
  const data = await fixture(); const metadata = await openRepository(data.repo);
  await assert.rejects(() => metadata.patch(data.unsafe, null, [], 3), (error: unknown) => (error as { code?: string }).code === 'CONTENT_DISABLED');
  const redacted = await openRepository(data.repo, { contentPolicy: 'redacted', excludePaths: ['unsafe.txt'] });
  const patch = await redacted.patch(data.unsafe, null, [], 3); assert.equal(patch.text, ''); assert.ok(patch.excludedPaths.length > 0);
  const full = await openRepository(data.repo, { contentPolicy: 'full' });
  assert.match((await full.patch(data.unsafe, null, [], 3)).text, /<script>alert\(1\)<\/script>/u);
  assert.match((await full.patch(data.root, null, [], 3)).text, /\+root/u);
});
