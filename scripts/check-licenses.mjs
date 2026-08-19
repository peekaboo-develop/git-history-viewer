import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const lock = JSON.parse(await fs.readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
const allowed = new Set(['MIT', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC']);
const production = Object.entries(lock.packages)
  .filter(([name, value]) => name.startsWith('node_modules/') && !value.dev)
  .map(([name, value]) => ({ name: name.slice('node_modules/'.length), license: value.license }));

assert.ok(production.length > 0, 'No production dependencies were found in package-lock.json.');
for (const dependency of production) {
  assert.equal(typeof dependency.license, 'string', `${dependency.name} has no recorded license.`);
  assert.ok(allowed.has(dependency.license), `${dependency.name} has an unreviewed license: ${dependency.license}`);
}

const summary = [...new Set(production.map((item) => item.license))].sort().join(', ');
process.stdout.write(`Checked ${production.length} production dependency records: ${summary}\n`);
