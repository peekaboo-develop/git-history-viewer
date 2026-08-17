import assert from 'node:assert/strict';
import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { defaultAiConfigPath, loadAiConfig, validateAiConfig } from '../src/ai/config.js';
import { createConfiguredProvider } from '../src/ai/factory.js';

const valid = { schemaVersion: '1', defaultProfileId: 'local-fast', profiles: [{ id: 'local-fast', label: 'Local fast', provider: 'ollama', model: 'qwen3:4b', ollamaPort: 11434, maxOutputTokens: 1536 }] };

test('AI config paths follow platform conventions', () => {
  assert.equal(defaultAiConfigPath('darwin', {}, '/Users/test'), '/Users/test/Library/Application Support/git-history-viewer/config.json');
  assert.equal(defaultAiConfigPath('linux', { XDG_CONFIG_HOME: '/cfg' }, '/home/test'), '/cfg/git-history-viewer/config.json');
  assert.equal(defaultAiConfigPath('linux', {}, '/home/test'), '/home/test/.config/git-history-viewer/config.json');
  assert.equal(defaultAiConfigPath('win32', { APPDATA: 'C:\\Data' }, 'C:\\Users\\test'), path.join('C:\\Data', 'git-history-viewer', 'config.json'));
});

test('AI config accepts strict provider profiles and rejects unsafe drift', () => {
  assert.deepEqual(validateAiConfig(valid).profiles[0]?.id, 'local-fast');
  assert.throws(() => validateAiConfig({ ...valid, apiKey: 'secret' }), /top-level/u);
  assert.throws(() => validateAiConfig({ ...valid, profiles: [...valid.profiles, valid.profiles[0]] }), /Duplicate/u);
  assert.throws(() => validateAiConfig({ ...valid, profiles: [{ ...valid.profiles[0], endpoint: 'https://evil.test' }] }), /invalid profile/u);
  const remote = validateAiConfig({ schemaVersion: '1', defaultProfileId: 'remote', profiles: [{ id: 'remote', label: 'OpenAI', provider: 'openai', model: 'gpt-5.4-mini', maxOutputTokens: 1536 }] });
  assert.equal(remote.profiles[0]?.provider, 'openai');
  assert.throws(() => validateAiConfig({ schemaVersion: '1', defaultProfileId: 'remote', profiles: [{ ...remote.profiles[0], endpoint: 'https://evil.test' }] }), /invalid profile/u);
  const anthropic = validateAiConfig({ schemaVersion: '1', defaultProfileId: 'claude', profiles: [{ id: 'claude', label: 'Claude', provider: 'anthropic', model: 'claude-sonnet-4-6', maxOutputTokens: 1536 }] });
  assert.equal(anthropic.profiles[0]?.provider, 'anthropic');
  assert.throws(() => validateAiConfig({ schemaVersion: '1', defaultProfileId: 'claude', profiles: [{ ...anthropic.profiles[0], credentialEnv: 'AWS_SECRET_ACCESS_KEY' }] }), /invalid profile/u);
});

test('AI config loader rejects symlinks and oversized files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ghv-config-')); const real = path.join(directory, 'real.json'); const link = path.join(directory, 'link.json'); const large = path.join(directory, 'large.json');
  await writeFile(real, JSON.stringify(valid)); await symlink(real, link); await writeFile(large, ' '.repeat(64 * 1024 + 1));
  assert.equal((await loadAiConfig(real)).defaultProfileId, 'local-fast');
  await assert.rejects(loadAiConfig(link), /symlink/u); await assert.rejects(loadAiConfig(large), /64 KiB/u);
});

test('provider factory routes profiles to fixed credential environments', () => {
  const openai = createConfiguredProvider({ id: 'openai', label: 'OpenAI', provider: 'openai', model: 'gpt-5.4-mini', maxOutputTokens: 1536 }, { OPENAI_API_KEY: 'openai-secret' });
  const anthropic = createConfiguredProvider({ id: 'claude', label: 'Claude', provider: 'anthropic', model: 'claude-sonnet-4-6', maxOutputTokens: 1536 }, { ANTHROPIC_API_KEY: 'anthropic-secret' });
  assert.equal(openai.descriptor.providerId, 'openai'); assert.equal(anthropic.descriptor.providerId, 'anthropic');
  assert.throws(() => createConfiguredProvider({ id: 'claude', label: 'Claude', provider: 'anthropic', model: 'claude-sonnet-4-6', maxOutputTokens: 1536 }, { OPENAI_API_KEY: 'wrong-provider-secret' }), /ANTHROPIC_API_KEY/u);
});
