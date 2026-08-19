import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const exec = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'git-history-viewer-pack-'));
const fixtureRoot = path.join(tempRoot, 'fixture');
const installRoot = path.join(tempRoot, 'install');

async function command(file, args, options = {}) {
  return exec(file, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...options });
}

async function npmCommand(args, options = {}) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('npm_execpath is required to run the packed smoke test.');
  return command(process.execPath, [npmCli, ...args], options);
}

async function createFixture() {
  await fs.mkdir(fixtureRoot, { recursive: true });
  await command('git', ['init', fixtureRoot]);
  await command('git', ['-C', fixtureRoot, 'config', 'user.name', 'Pack Test']);
  await command('git', ['-C', fixtureRoot, 'config', 'user.email', 'pack@example.invalid']);
  await fs.writeFile(path.join(fixtureRoot, 'README.md'), '# packed smoke\n');
  await command('git', ['-C', fixtureRoot, 'add', '--', 'README.md']);
  await command('git', ['-C', fixtureRoot, 'commit', '-m', 'fixture']);
}

async function scanPackage(packageRoot) {
  const files = [];
  const visit = async (directory) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) files.push(target);
    }
  };
  await visit(packageRoot);
  const textExtensions = new Set(['.css', '.html', '.js', '.json', '.map', '.md', '.mjs', '.yaml', '.yml']);
  for (const file of files.filter((item) => textExtensions.has(path.extname(item)))) {
    const content = await fs.readFile(file, 'utf8');
    assert.doesNotMatch(content, /(?:^|[^A-Za-z])\/Users\/[A-Za-z0-9._-]+\//u, `Personal macOS path in ${path.relative(packageRoot, file)}`);
    assert.doesNotMatch(content, /(?:^|[^A-Za-z])\/home\/[A-Za-z0-9._-]+\//u, `Personal Linux path in ${path.relative(packageRoot, file)}`);
    assert.doesNotMatch(content, /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+\\/u, `Personal Windows path in ${path.relative(packageRoot, file)}`);
  }
}

async function startWeb(bin) {
  const child = spawn(process.execPath, [bin, 'web', fixtureRoot, '--port', '0', '--no-open'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const bootstrapUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Web startup timed out: ${stderr}`)), 10_000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const match = stdout.match(/Git History Viewer: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/u);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Web exited before startup (${code}): ${stderr}`)); });
  });
  return { child, bootstrapUrl };
}

async function stopWeb(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('Web did not stop after SIGTERM.')), 5_000))]);
}

try {
  await createFixture();
  const packed = await npmCommand(['pack', '--ignore-scripts', '--json', '--silent', '--pack-destination', tempRoot], { cwd: projectRoot });
  const report = JSON.parse(packed.stdout)[0];
  assert.equal(report.name, '@peekaboo-develop/git-history-viewer');
  const paths = report.files.map((item) => item.path);
  assert.ok(paths.includes('dist/src/cli/main.js'));
  assert.ok(paths.includes('docs/RELEASING.md'));
  assert.ok(paths.includes('integrations/codex-skill/SKILL.md'));
  assert.ok(paths.includes('CONTRIBUTING.md'));
  assert.ok(paths.includes('NOTICE'));
  assert.ok(paths.includes('third_party/gh-pr-graph-LICENSE'));
  assert.ok(paths.includes('third_party/le-git-graph-LICENSE'));
  assert.ok(paths.every((item) => !item.startsWith('src/') && !item.startsWith('test/') && !item.startsWith('scripts/')));

  const tarball = path.join(tempRoot, report.filename);
  await npmCommand(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline', '--prefix', installRoot, tarball]);
  const packageRoot = path.join(installRoot, 'node_modules', '@peekaboo-develop', 'git-history-viewer');
  const bin = path.join(packageRoot, 'bin', 'git-history-viewer.mjs');
  await scanPackage(packageRoot);
  const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.author, 'Takuto Makabe');
  assert.equal(manifest.repository.url, 'git+https://github.com/peekaboo-develop/git-history-viewer.git');
  assert.deepEqual(manifest.publishConfig, { access: 'public', tag: 'alpha', provenance: true });

  const version = await command(process.execPath, [bin, 'version']);
  assert.equal(version.stdout.trim(), '0.1.0-alpha.0');
  const inspected = await command(process.execPath, [bin, 'inspect', 'repository', '--repo', fixtureRoot, '--json']);
  const repository = JSON.parse(inspected.stdout);
  assert.equal(repository.schemaVersion, '1');
  assert.equal(repository.data.name, path.basename(fixtureRoot));

  const web = await startWeb(bin);
  try {
    const bootstrap = await fetch(web.bootstrapUrl, { redirect: 'manual' });
    assert.equal(bootstrap.status, 303);
    const cookie = bootstrap.headers.get('set-cookie')?.split(';', 1)[0];
    assert.ok(cookie, 'Web bootstrap did not set a session cookie.');
    const cleanUrl = new URL(bootstrap.headers.get('location') ?? '/', web.bootstrapUrl);
    assert.equal(cleanUrl.search, '');
    const response = await fetch(new URL('/api/v1/repository', cleanUrl), { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.name, path.basename(fixtureRoot));
  } finally {
    await stopWeb(web.child);
  }

  const client = new Client({ name: 'packed-smoke', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [bin, 'mcp', '--repo', fixtureRoot, '--content-policy', 'metadata'], stderr: 'pipe' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((item) => item.name === 'git_history_repository'));
    assert.ok(!tools.tools.some((item) => item.name === 'git_history_get_commit_patch'));
    const result = await client.callTool({ name: 'git_history_repository', arguments: {} });
    assert.equal(result.structuredContent?.schemaVersion, '1');
    assert.doesNotMatch(JSON.stringify(result), new RegExp(fixtureRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'));
  } finally {
    await transport.close();
  }

  process.stdout.write(`Packed smoke passed: ${report.filename} (${report.size} bytes)\n`);
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
