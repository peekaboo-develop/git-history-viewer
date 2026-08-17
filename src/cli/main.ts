import { spawn } from 'node:child_process';
import path from 'node:path';
import { FileAiCache } from '../ai/cache.js';
import { asViewerError, ViewerError } from '../core/errors.js';
import { openRepository, type RepositoryOptions } from '../core/repository.js';
import { runMcpServer } from '../mcp/server.js';
import { SCHEMA_VERSION, success, type ContentPolicy } from '../schema/types.js';
import { createViewerServer } from '../web/server.js';

interface Parsed { command: string; positional: string[]; options: Map<string, string[]>; flags: Set<string> }
function parse(argv: string[]): Parsed {
  const command = argv.shift() ?? 'help'; const positional: string[] = []; const options = new Map<string, string[]>(); const flags = new Set<string>();
  const valueOptions = new Set(['repo', 'port', 'limit', 'content-policy', 'exclude-path', 'parent-index']);
  while (argv.length) {
    const item = argv.shift() ?? '';
    if (!item.startsWith('--')) { positional.push(item); continue; }
    const key = item.slice(2);
    if (!valueOptions.has(key)) { flags.add(key); continue; }
    const value = argv.shift(); if (!value || value.startsWith('--')) throw new ViewerError('INVALID_ARGUMENT', `Missing value for --${key}.`);
    const values = options.get(key) ?? []; values.push(value); options.set(key, values);
  }
  return { command, positional, options, flags };
}
function option(parsed: Parsed, key: string): string | undefined { return parsed.options.get(key)?.at(-1); }
function validateExcludes(values: string[]): string[] {
  const unique = new Set<string>();
  for (const raw of values) {
    const value = raw.replaceAll('\\', '/');
    if (!value || value.startsWith('/') || value.includes('\0') || value.split('/').some((part) => part === '.' || part === '..')) throw new ViewerError('INVALID_ARGUMENT', 'Exclude paths must be normalized repository-relative literal prefixes.');
    unique.add(value.replace(/\/$/u, ''));
  }
  return [...unique];
}
function exitCode(code: string): number {
  if (['INVALID_ARGUMENT', 'INVALID_OID'].includes(code)) return 2; if (['CONTENT_DISABLED', 'CONTENT_EXCLUDED'].includes(code)) return 3;
  if (['NOT_FOUND', 'NOT_GIT_REPOSITORY'].includes(code)) return 4; if (['STALE_CURSOR', 'STATE_CHANGED'].includes(code)) return 5;
  if (code === 'OUTPUT_LIMIT') return 6; if (code === 'TIMEOUT') return 7; return 1;
}
function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(command, args, { shell: false, detached: true, stdio: 'ignore' }).unref();
}
function help(): void {
  process.stdout.write(`Git History Viewer\n\nCommands:\n  web [repo] [--port 0|PORT] [--limit N] [--no-open]\n  mcp --repo PATH [--content-policy metadata|redacted|full] [--exclude-path PREFIX]\n  inspect repository|status|refs|commits|commit|changes [OID] [--repo PATH] [--json]\n  cache status|clear [--json]\n  doctor [repo] [--json]\n  version\n`);
}
async function main(): Promise<void> {
  const parsed = parse(process.argv.slice(2));
  if (parsed.command === 'help' || parsed.flags.has('help')) return help();
  if (parsed.command === 'version') return void process.stdout.write('0.1.0-alpha.0\n');
  if (parsed.command === 'cache') {
    if (parsed.positional.length > 1 || parsed.options.size > 0 || [...parsed.flags].some((flag) => flag !== 'json')) throw new ViewerError('INVALID_ARGUMENT', 'Unsupported cache command argument.');
    const cache = new FileAiCache(); const action = parsed.positional[0] ?? 'status';
    if (action === 'status') {
      const data = await cache.stats();
      return void process.stdout.write(parsed.flags.has('json') ? `${JSON.stringify(success('cache-v1', data))}\n` : `AI cache: ${data.entries} entries, ${data.bytes} bytes\n`);
    }
    if (action === 'clear') {
      const data = await cache.clear();
      return void process.stdout.write(parsed.flags.has('json') ? `${JSON.stringify(success('cache-v1', data))}\n` : `AI cache cleared: ${data.removedEntries} entries, ${data.removedBytes} bytes\n`);
    }
    throw new ViewerError('INVALID_ARGUMENT', 'Unknown cache command.');
  }
  const repoPath = path.resolve(option(parsed, 'repo') ?? parsed.positional[parsed.command === 'web' || parsed.command === 'doctor' ? 0 : 1] ?? process.cwd());
  const policy = (option(parsed, 'content-policy') ?? 'metadata') as ContentPolicy;
  if (!['metadata', 'redacted', 'full'].includes(policy)) throw new ViewerError('INVALID_ARGUMENT', 'Unknown content policy.');
  const repositoryOptions: RepositoryOptions = { contentPolicy: policy, excludePaths: validateExcludes(parsed.options.get('exclude-path') ?? []) };
  const reader = await openRepository(repoPath, repositoryOptions);
  if (parsed.command === 'mcp') {
    if (!option(parsed, 'repo')) throw new ViewerError('INVALID_ARGUMENT', 'mcp requires an explicit --repo path.');
    return runMcpServer(reader);
  }
  if (parsed.command === 'web') {
    const port = Number(option(parsed, 'port') ?? 8449); const limit = Number(option(parsed, 'limit') ?? 200);
    if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new ViewerError('INVALID_ARGUMENT', 'Port must be between 0 and 65535.');
    const viewer = await createViewerServer(reader, { port, limit });
    try { await viewer.listen(); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new ViewerError('INVALID_ARGUMENT', `Port ${port} is already in use.`); throw error; }
    process.stdout.write(`Git History Viewer: ${viewer.url}\nRepository: ${path.basename(reader.root)}\nRead-only mode. Remote refs are never fetched.\n`);
    if (!parsed.flags.has('no-open')) openBrowser(viewer.url);
    const shutdown = () => viewer.close().finally(() => process.exit(0)); process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown); return;
  }
  if (parsed.command === 'doctor') {
    const data = { repository: await reader.repository(), git: process.env.PATH ? 'available' : 'unknown', checks: ['repository', 'read-only-core'] };
    return void process.stdout.write(parsed.flags.has('json') ? `${JSON.stringify(success(await reader.generation(), data))}\n` : `OK ${data.repository.name} (${data.repository.objectFormat})\n`);
  }
  if (parsed.command === 'inspect') {
    const subject = parsed.positional[0]; const oid = parsed.positional[1]; let data: unknown;
    if (subject === 'repository') data = await reader.repository(); else if (subject === 'status') data = await reader.status(true);
    else if (subject === 'refs') data = { items: await reader.refs(), truncated: false, omittedCount: 0, nextCursor: null };
    else if (subject === 'commits') data = await reader.commits(Number(option(parsed, 'limit') ?? 50));
    else if (subject === 'commit' && oid) data = await reader.commit(oid);
    else if (subject === 'changes' && oid) data = await reader.changes(oid, option(parsed, 'parent-index') === undefined ? null : Number(option(parsed, 'parent-index')), true);
    else throw new ViewerError('INVALID_ARGUMENT', 'Unknown or incomplete inspect command.');
    const envelope = success(await reader.generation(), data);
    process.stdout.write(parsed.flags.has('json') ? `${JSON.stringify(envelope)}\n` : `${JSON.stringify(data, null, 2)}\n`); return;
  }
  throw new ViewerError('INVALID_ARGUMENT', 'Unknown command.');
}

main().catch((error) => {
  const known = asViewerError(error); process.stderr.write(`${JSON.stringify({ schemaVersion: SCHEMA_VERSION, generation: '', data: null, warnings: [], error: known.publicValue() })}\n`); process.exitCode = exitCode(known.code);
});
