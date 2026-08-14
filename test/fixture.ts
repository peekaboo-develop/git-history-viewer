import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr || `${args.join(' ')} failed`);
  return result.stdout.trim();
}

export async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'git-history-public-')); const repo = path.join(base, 'repo'); const remote = path.join(base, 'origin.git');
  git(base, 'init', '-b', 'main', repo); git(repo, 'config', 'user.name', 'Viewer Test'); git(repo, 'config', 'user.email', 'viewer@example.test');
  await writeFile(path.join(repo, 'root.txt'), 'root\n'); git(repo, 'add', '--', 'root.txt'); git(repo, 'commit', '-m', 'root commit'); const root = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-b', 'feature'); await writeFile(path.join(repo, 'feature.txt'), 'feature\n'); git(repo, 'add', '--', 'feature.txt'); git(repo, 'commit', '-m', 'feature commit');
  git(repo, 'checkout', 'main'); await writeFile(path.join(repo, 'main.txt'), 'main\n'); git(repo, 'add', '--', 'main.txt'); git(repo, 'commit', '-m', 'main commit');
  git(repo, 'merge', '--no-ff', 'feature', '-m', 'merge feature'); const merge = git(repo, 'rev-parse', 'HEAD'); git(repo, 'tag', '-a', 'v1', '-m', 'version one');
  git(base, 'init', '--bare', remote); git(repo, 'remote', 'add', 'origin', remote); git(repo, 'push', '-u', 'origin', 'main', 'feature', '--tags');
  await writeFile(path.join(repo, 'unsafe.txt'), '<script>alert(1)</script>\n'); git(repo, 'add', '--', 'unsafe.txt'); git(repo, 'commit', '-m', '<script>alert(1)</script>', '-m', '本文'); const unsafe = git(repo, 'rev-parse', 'HEAD');
  const tree = git(repo, 'rev-parse', `${root}^{tree}`); const dangling = git(repo, 'commit-tree', tree, '-m', 'dangling secret');
  return { base, repo, root, merge, unsafe, dangling };
}
