import { spawn } from 'node:child_process';
import { ViewerError } from './errors.js';

const FIXED_CONFIG = ['-c', 'core.fsmonitor=false', '-c', 'color.ui=false', '-c', 'core.pager=cat'];
const OPERATIONS = new Set([
  'repoInfo', 'head', 'refs', 'status', 'worktrees', 'graph', 'unpushed',
  'authorizeCommit', 'commitMeta', 'commitChanges', 'commitPatch',
]);

export type GitOperation = 'repoInfo' | 'head' | 'refs' | 'status' | 'worktrees' | 'graph' |
  'unpushed' | 'authorizeCommit' | 'commitMeta' | 'commitChanges' | 'commitPatch';

export interface GitResult { stdout: Buffer; stderr: Buffer; code: number }

function childEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'ComSpec', 'TMPDIR', 'TEMP', 'TMP']) {
    if (process.env[key] !== undefined) result[key] = process.env[key];
  }
  return {
    ...result,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_PAGER: 'cat',
    GIT_CONFIG_NOSYSTEM: '1',
    LC_ALL: 'C',
  };
}

export class GitRunner {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly cwd: string, readonly timeoutMs = 5_000, readonly outputLimit = 8 * 1024 * 1024) {}

  run(operation: GitOperation, args: readonly string[], allowFailure = false): Promise<GitResult> {
    if (!OPERATIONS.has(operation)) return Promise.reject(new ViewerError('INVALID_ARGUMENT', 'Unknown Git operation.'));
    const task = () => this.spawn(args, allowFailure);
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private spawn(args: readonly string[], allowFailure: boolean): Promise<GitResult> {
    return new Promise((resolve, reject) => {
      const child = spawn('git', [...FIXED_CONFIG, ...args], {
        cwd: this.cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: childEnvironment(),
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let terminalError: ViewerError | null = null;
      const timer = setTimeout(() => {
        terminalError = new ViewerError('TIMEOUT', 'Git command timed out.');
        child.kill('SIGKILL');
      }, this.timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > this.outputLimit && !terminalError) {
          terminalError = new ViewerError('OUTPUT_LIMIT', 'Git output exceeded the configured limit.');
          child.kill('SIGKILL');
          return;
        }
        if (!terminalError) stdout.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(new ViewerError('GIT_FAILED', 'Git could not be started.', { cause: error }));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (terminalError) return reject(terminalError);
        const result = { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code: code ?? -1 };
        if (result.code === 0 || allowFailure) return resolve(result);
        const message = result.stderr.toString('utf8').trim() || `Git exited with ${result.code}.`;
        reject(new ViewerError('GIT_FAILED', message, { details: { exitCode: result.code } }));
      });
    });
  }
}

export const gitOperationNames = Object.freeze([...OPERATIONS]);
