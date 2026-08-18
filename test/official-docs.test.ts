import assert from 'node:assert/strict';
import test from 'node:test';
import { recommendOfficialDocs } from '../src/docs/official.js';
import type { Change } from '../src/schema/types.js';

const change = (path: string, state = 'M'): Change => ({ state, path: { encoding: 'utf8', display: path, rawBase64: null }, oldPath: null, added: 1, deleted: 1 });

test('official documents come only from the fixed registry and remain version-neutral', () => {
  const result = recommendOfficialDocs([change('.github/workflows/ci.yml'), change('vite.config.ts'), change('src/App.vue')]);
  assert.deepEqual(result.map((item) => item.id), ['github-actions', 'vite']);
  assert.ok(result.every((item) => item.url.startsWith('https://') && item.version === null));
});

test('unknown, deleted, and non-UTF8 paths produce no recommendation', () => {
  const nonUtf8: Change = { ...change('ignored'), path: { encoding: 'base64', display: '(non-UTF-8 path)', rawBase64: 'AA==' } };
  assert.deepEqual(recommendOfficialDocs([change('src/plain.js'), change('vite.config.ts', 'D'), nonUtf8]), []);
  assert.deepEqual(recommendOfficialDocs([change('Dockerfile')], 99), []);
});
