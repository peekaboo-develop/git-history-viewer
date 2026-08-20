import assert from 'node:assert/strict';
import test from 'node:test';
import type { CommitSummary, GitRef } from '../src/schema/types.js';
import { authorOptions, branchOptions, matchesHighlight, relatedHistory } from '../src/web/filters.js';

const oid = (digit: string) => digit.repeat(40);
const ref = (name: string, target: string, kind: GitRef['kind'] = 'local', current = false): GitRef => ({ name, fullName: `refs/${kind === 'local' ? 'heads' : 'remotes'}/${name}`, kind, objectOid: target, peeledCommitOid: target, upstream: null, current });
const commit = (id: string, parents: string[], authorName: string, refs: GitRef[] = []): CommitSummary => ({ oid: oid(id), parents: parents.map(oid), authorName, authoredAt: '2026-08-20T00:00:00Z', subject: `commit ${id}`, refs, unpushed: false });

test('branch filter preserves the selected tip ancestry without unrelated branches', () => {
  const values = [commit('5', ['3'], 'Alice', [ref('main', oid('5'), 'local', true)]), commit('4', ['2'], 'Bob', [ref('feature', oid('4'))]), commit('3', ['2'], 'Alice'), commit('2', ['1'], 'Bob'), commit('1', [], 'Alice')];
  assert.deepEqual(relatedHistory(values, 'feature').map((item) => item.oid), [oid('4'), oid('2'), oid('1')]);
  assert.equal(branchOptions(values)[0]?.value, 'main');
});

test('author and search filters identify matches while retaining contextual commits', () => {
  const values = [commit('2', ['1'], 'Alice'), commit('1', [], 'Bob')];
  assert.deepEqual(authorOptions(values), [{ value: 'Alice', label: 'Alice', count: 1 }, { value: 'Bob', label: 'Bob', count: 1 }]);
  assert.equal(matchesHighlight(values[0]!, 'COMMIT 2', 'Alice'), true);
  assert.equal(matchesHighlight(values[1]!, '', 'Alice'), false);
});
