import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fixture } from './fixture.js';

async function clientFor(repo: string, policy: string) {
  const client = new Client({ name: 'git-history-viewer-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/src/cli/main.js'), 'mcp', '--repo', repo, '--content-policy', policy], stderr: 'pipe' });
  await client.connect(transport); return { client, transport };
}

test('metadata MCP exposes read-only tools without patch or private paths', async (t) => {
  const data = await fixture(); const { client, transport } = await clientFor(data.repo, 'metadata'); t.after(() => transport.close());
  const listed = await client.listTools(); const names = listed.tools.map((item) => item.name);
  assert.ok(names.includes('git_history_get_commit')); assert.ok(!names.includes('git_history_get_commit_patch'));
  assert.ok(listed.tools.every((item) => item.annotations?.readOnlyHint === true));
  const repo = await client.callTool({ name: 'git_history_repository', arguments: {} }); const serialized = JSON.stringify(repo);
  assert.doesNotMatch(serialized, new RegExp(data.repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u')); assert.doesNotMatch(serialized, /viewer@example\.test/u);
});

test('redacted MCP registers patch and Japanese prompts', async (t) => {
  const data = await fixture(); const { client, transport } = await clientFor(data.repo, 'redacted'); t.after(() => transport.close());
  assert.ok((await client.listTools()).tools.some((item) => item.name === 'git_history_get_commit_patch'));
  const prompts = await client.listPrompts(); assert.ok(prompts.prompts.some((item) => item.name === 'explain_commit_ja')); assert.ok(prompts.prompts.some((item) => item.name === 'review_commit_risk_ja'));
});

test('MCP exposes bounded static guidance resources without repository data', async (t) => {
  const data = await fixture(); const { client, transport } = await clientFor(data.repo, 'metadata'); t.after(() => transport.close());
  const listed = await client.listResources(); const uris = listed.resources.map((item) => item.uri);
  assert.deepEqual(uris.sort(), ['git-history-viewer://docs/llm-guide/v1', 'git-history-viewer://docs/privacy/v1', 'git-history-viewer://schemas/ai-explanation/v1'].sort());
  for (const uri of uris) {
    const resource = await client.readResource({ uri }); const serialized = JSON.stringify(resource);
    assert.ok(Buffer.byteLength(serialized) < 32 * 1024); assert.doesNotMatch(serialized, new RegExp(data.repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'));
  }
  const guide = await client.readResource({ uri: 'git-history-viewer://docs/llm-guide/v1' });
  assert.match(JSON.stringify(guide), /first-parent/u); assert.match(JSON.stringify(guide), /untrusted evidence/u);
});
