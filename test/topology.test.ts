import assert from 'node:assert/strict';
import test from 'node:test';
import type { CommitSummary, GitRef, WorktreeInfo } from '../src/schema/types.js';
import { buildTopology } from '../src/web/topology.js';

const oid = (digit: string) => digit.repeat(40);
const ref = (name: string, target: string, kind: GitRef['kind'] = 'local'): GitRef => ({ name, fullName: `refs/heads/${name}`, kind, objectOid: target, peeledCommitOid: target, upstream: null, current: name === 'main' });
const commit = (id: string, parents: string[], refs: GitRef[] = []): CommitSummary => ({ oid: id, parents, refs, authorName: 'Test', authoredAt: '2026-08-17T00:00:00Z', subject: `commit ${id[0]}`, unpushed: false });

test('topology keeps landmarks and folds linear commit runs', () => {
  const root = oid('1'); const hidden = oid('2'); const branch = oid('3'); const main = oid('4'); const merge = oid('5');
  const commits = [commit(merge, [main, branch], [ref('main', merge)]), commit(main, [hidden]), commit(branch, [hidden], [ref('feature', branch)]), commit(hidden, [root]), commit(root, [])];
  const worktree: WorktreeInfo = { id: 'one', displayName: 'feature-tree', head: branch, branch: 'feature', detached: false, current: false, locked: false, prunable: false };
  const graph = buildTopology(commits, [worktree], merge);
  assert.deepEqual(new Set(graph.nodes.map((node) => node.oid)), new Set([root, branch, merge]));
  assert.equal(graph.hiddenCommitCount, 2);
  assert.ok(graph.edges.some((edge) => edge.source === root && edge.target === branch && edge.collapsed === 1));
  assert.ok(graph.edges.some((edge) => edge.source === root && edge.target === merge && edge.collapsed === 2));
  assert.ok(graph.nodes.find((node) => node.oid === branch)?.kinds.includes('worktree'));
  assert.ok(graph.nodes.find((node) => node.oid === merge)?.kinds.includes('head'));
});

test('topology node limit prioritizes refs and reports limiting', () => {
  const commits: CommitSummary[] = [];
  for (let index = 0; index < 12; index += 1) {
    const id = index.toString(16).repeat(40); const parent = index === 0 ? [] : [(index - 1).toString(16).repeat(40)];
    commits.unshift(commit(id, parent, index % 2 === 0 ? [ref(`branch-${index}`, id)] : []));
  }
  const graph = buildTopology(commits, [], commits[0]?.oid ?? null, 4);
  assert.equal(graph.nodes.length, 4); assert.equal(graph.limited, true);
  assert.ok(graph.nodes.some((node) => node.oid === commits[0]?.oid)); assert.ok(graph.nodes.some((node) => node.refs.length > 0));
});
