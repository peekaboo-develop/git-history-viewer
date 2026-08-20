import assert from 'node:assert/strict';
import test from 'node:test';
import type { Change } from '../src/schema/types.js';
import { changeLabel, changeTone, changeTotals, commitDescription } from '../src/web/detail.js';

const path = { display: 'file.ts', encoding: 'utf8' as const, rawBase64: null };
const change = (state: string, added: number | null, deleted: number | null): Change => ({ state, path, oldPath: null, added, deleted });

test('commit description removes a duplicated subject line', () => {
  assert.equal(commitDescription('feat: subject\n\nWhy this changed.', 'feat: subject'), 'Why this changed.');
  assert.equal(commitDescription('feat: subject', 'feat: subject'), '');
  assert.equal(commitDescription('Independent body', 'feat: subject'), 'Independent body');
});

test('change presentation uses Japanese labels and totals measurable lines', () => {
  assert.equal(changeLabel('R100'), '名前変更');
  assert.equal(changeTone('D'), 'deleted');
  assert.deepEqual(changeTotals([change('A', 12, 0), change('M', 3, 2), change('M', null, null)]), { files: 3, additions: 15, deletions: 2, binary: 1 });
});
