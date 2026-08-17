import { lstat, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ViewerError } from '../core/errors.js';

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_PROFILES = 20;

export interface OllamaProfileConfig {
  id: string;
  label: string;
  provider: 'ollama';
  model: string;
  ollamaPort: number;
  maxOutputTokens: number;
}

export interface AiConfig {
  schemaVersion: '1';
  defaultProfileId: string;
  profiles: OllamaProfileConfig[];
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, allowed: string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)); }
function profileId(value: unknown): value is string { return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(value); }
function cleanLabel(value: unknown, maximum: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value); }

export function defaultAiConfigPath(platform = process.platform, environment: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'git-history-viewer', 'config.json');
  if (platform === 'win32') {
    const appData = environment.APPDATA;
    if (!appData) throw new ViewerError('INVALID_ARGUMENT', 'APPDATA is required to locate the AI config.');
    return path.join(appData, 'git-history-viewer', 'config.json');
  }
  return path.join(environment.XDG_CONFIG_HOME || path.join(home, '.config'), 'git-history-viewer', 'config.json');
}

export function validateAiConfig(value: unknown): AiConfig {
  if (!record(value) || !exactKeys(value, ['schemaVersion', 'defaultProfileId', 'profiles']) || value.schemaVersion !== '1' || !profileId(value.defaultProfileId) || !Array.isArray(value.profiles) || value.profiles.length === 0 || value.profiles.length > MAX_PROFILES) throw new ViewerError('INVALID_ARGUMENT', 'AI config has an invalid top-level structure.');
  const ids = new Set<string>(); const profiles: OllamaProfileConfig[] = [];
  for (const item of value.profiles) {
    if (!record(item) || !exactKeys(item, ['id', 'label', 'provider', 'model', 'ollamaPort', 'maxOutputTokens']) || !profileId(item.id) || !cleanLabel(item.label, 80) || item.provider !== 'ollama' || !cleanLabel(item.model, 160) || /(?:^|[:_-])cloud(?:$|[:_-])/iu.test(item.model) || !Number.isInteger(item.ollamaPort) || Number(item.ollamaPort) < 1 || Number(item.ollamaPort) > 65_535 || !Number.isInteger(item.maxOutputTokens) || Number(item.maxOutputTokens) < 128 || Number(item.maxOutputTokens) > 8192) throw new ViewerError('INVALID_ARGUMENT', 'AI config contains an invalid profile.');
    if (ids.has(item.id)) throw new ViewerError('INVALID_ARGUMENT', `Duplicate AI profile ID: ${item.id}`);
    ids.add(item.id);
    profiles.push({ id: item.id, label: item.label, provider: 'ollama', model: item.model, ollamaPort: Number(item.ollamaPort), maxOutputTokens: Number(item.maxOutputTokens) });
  }
  if (!ids.has(value.defaultProfileId)) throw new ViewerError('INVALID_ARGUMENT', 'The default AI profile does not exist.');
  return { schemaVersion: '1', defaultProfileId: value.defaultProfileId, profiles };
}

export async function loadAiConfig(configPath = defaultAiConfigPath()): Promise<AiConfig> {
  let info;
  try { info = await lstat(configPath); } catch (error) { throw new ViewerError('NOT_FOUND', `AI config not found: ${configPath}`, { cause: error }); }
  if (info.isSymbolicLink() || !info.isFile()) throw new ViewerError('INVALID_ARGUMENT', 'AI config must be a regular file, not a symlink.');
  if (info.size > MAX_CONFIG_BYTES) throw new ViewerError('OUTPUT_LIMIT', 'AI config exceeds 64 KiB.');
  const raw = await readFile(configPath, 'utf8');
  let parsed: unknown; try { parsed = JSON.parse(raw); } catch { throw new ViewerError('INVALID_ARGUMENT', 'AI config must be valid JSON.'); }
  return validateAiConfig(parsed);
}
