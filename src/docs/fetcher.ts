import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';
import { parse } from 'parse5';
import { ViewerError } from '../core/errors.js';
import { officialDocById } from './official.js';

const MAX_RAW_BYTES = 1024 * 1024;
const MAX_TEXT_BYTES = 4 * 1024;
const blockedV4 = new net.BlockList(); const blockedV6 = new net.BlockList();
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) blockedV4.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [['::', 96], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20], ['5f00::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]] as const) blockedV6.addSubnet(network, prefix, 'ipv6');

export function isPublicAddress(address: string, family: number): boolean {
  const kind = family === 4 ? 'ipv4' : family === 6 ? 'ipv6' : null;
  return kind !== null && net.isIP(address) === family && !(family === 4 ? blockedV4 : blockedV6).check(address, kind);
}

type HtmlNode = { nodeName?: string; tagName?: string; value?: string; childNodes?: HtmlNode[] };
const excluded = new Set(['script', 'style', 'nav', 'header', 'footer', 'form', 'svg', 'noscript', 'template']);

function find(node: HtmlNode, names: Set<string>): HtmlNode | null {
  if (node.tagName && names.has(node.tagName)) return node;
  for (const child of node.childNodes ?? []) { const found = find(child, names); if (found) return found; }
  return null;
}
function collect(node: HtmlNode, values: string[]): void {
  if (node.tagName && excluded.has(node.tagName)) return;
  if (node.nodeName === '#text' && typeof node.value === 'string') values.push(node.value);
  for (const child of node.childNodes ?? []) collect(child, values);
}
function clipUtf8(value: string, maximum: number): string {
  const bytes = Buffer.from(value); if (bytes.length <= maximum) return value;
  return bytes.subarray(0, maximum).toString('utf8').replace(/\uFFFD$/u, '').trimEnd();
}
export function extractOfficialText(raw: string, contentType: string): string {
  if (contentType.startsWith('text/plain')) return clipUtf8(raw.replace(/\s+/gu, ' ').trim(), MAX_TEXT_BYTES);
  if (!contentType.startsWith('text/html')) throw new ViewerError('PROVIDER_OUTPUT_INVALID', 'The official document has an unsupported content type.');
  const document = parse(raw) as unknown as HtmlNode;
  const root = find(document, new Set(['main', 'article'])) ?? find(document, new Set(['body']));
  if (!root) throw new ViewerError('PROVIDER_OUTPUT_INVALID', 'The official document has no readable content.');
  const values: string[] = []; collect(root, values);
  const text = clipUtf8(values.join(' ').replace(/\s+/gu, ' ').trim(), MAX_TEXT_BYTES);
  if (!text) throw new ViewerError('PROVIDER_OUTPUT_INVALID', 'The official document has no readable text.');
  return text;
}

export interface FetchedOfficialDocument { id: string; title: string; url: string; fetchedAt: string; excerpt: string; byteCount: number }
export interface FetchTransport { fetch(url: URL): Promise<{ status: number; contentType: string; contentEncoding: string; body: Buffer }> }
export type AddressResolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export class PinnedHttpsTransport implements FetchTransport {
  constructor(
    private readonly resolveAddresses: AddressResolver = (hostname) => dns.lookup(hostname, { all: true, verbatim: true }),
    private readonly dnsTimeoutMs = 5_000,
  ) {}
  async fetch(url: URL): Promise<{ status: number; contentType: string; contentEncoding: string; body: Buffer }> {
    if (url.protocol !== 'https:' || url.port && url.port !== '443' || url.username || url.password || url.search || url.hash) throw new ViewerError('INVALID_ARGUMENT', 'The official document URL is invalid.');
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new ViewerError('PROVIDER_TIMEOUT', 'The official document DNS lookup timed out.')), this.dnsTimeoutMs);
    });
    let addresses: Array<{ address: string; family: number }>;
    try { addresses = await Promise.race([this.resolveAddresses(url.hostname), timeout]); }
    finally { if (timer) clearTimeout(timer); }
    if (addresses.length === 0 || addresses.length > 16 || addresses.some((item) => !isPublicAddress(item.address, item.family))) throw new ViewerError('PROVIDER_UNAVAILABLE', 'The official document destination was rejected.');
    const selected = addresses[0]!; const approved = new Set(addresses.map((item) => item.address));
    return new Promise((resolve, reject) => {
      let settled = false;
      const request = https.request(url, {
        method: 'GET', agent: false, servername: url.hostname,
        headers: { Accept: 'text/html,text/plain', 'Accept-Encoding': 'identity', 'User-Agent': 'git-history-viewer/0.1' },
        lookup: (_hostname, lookupOptions, callback) => {
          if (typeof lookupOptions === 'object' && lookupOptions.all) (callback as unknown as (error: null, addresses: Array<{ address: string; family: number }>) => void)(null, [selected]);
          else (callback as unknown as (error: null, address: string, family: number) => void)(null, selected.address, selected.family);
        },
      }, (response) => {
        const status = response.statusCode ?? 0; const contentType = String(response.headers['content-type'] ?? '').toLowerCase(); const contentEncoding = String(response.headers['content-encoding'] ?? 'identity').toLowerCase();
        const chunks: Buffer[] = []; let total = 0;
        response.on('data', (chunk: Buffer) => { if (settled) return; total += chunk.length; if (total > MAX_RAW_BYTES) { settled = true; clearTimeout(totalTimer); response.destroy(); reject(new ViewerError('PROVIDER_OUTPUT_LIMIT', 'The official document is too large.')); return; } chunks.push(chunk); });
        response.on('end', () => { if (!settled) { settled = true; clearTimeout(totalTimer); resolve({ status, contentType, contentEncoding, body: Buffer.concat(chunks) }); } });
        response.on('error', (error) => { if (!settled) { settled = true; clearTimeout(totalTimer); reject(new ViewerError('PROVIDER_UNAVAILABLE', 'The official document could not be read.', { cause: error })); } });
      });
      const totalTimer = setTimeout(() => request.destroy(new ViewerError('PROVIDER_TIMEOUT', 'The official document request timed out.')), 10_000);
      request.setTimeout(5_000, () => request.destroy(new ViewerError('PROVIDER_TIMEOUT', 'The official document connection timed out.')));
      request.on('socket', (socket) => socket.once('secureConnect', () => { if (!socket.remoteAddress || !approved.has(socket.remoteAddress)) request.destroy(new ViewerError('PROVIDER_UNAVAILABLE', 'The official document connection was rejected.')); }));
      request.on('error', (error) => { if (!settled) { settled = true; clearTimeout(totalTimer); reject(error instanceof ViewerError ? error : new ViewerError('PROVIDER_UNAVAILABLE', 'The official document request failed.', { cause: error })); } });
      request.end();
    });
  }
}

export class OfficialDocumentFetcher {
  constructor(private readonly transport: FetchTransport = new PinnedHttpsTransport()) {}
  async fetch(id: string): Promise<FetchedOfficialDocument> {
    const entry = officialDocById(id); if (!entry) throw new ViewerError('INVALID_ARGUMENT', 'Unknown official document ID.');
    const url = new URL(entry.url); const response = await this.transport.fetch(url);
    if (response.status !== 200) throw new ViewerError('PROVIDER_UNAVAILABLE', 'The official document request was rejected.');
    if (response.contentEncoding && response.contentEncoding !== 'identity') throw new ViewerError('PROVIDER_OUTPUT_INVALID', 'Compressed official documents are not accepted.');
    const excerpt = extractOfficialText(response.body.toString('utf8'), response.contentType);
    return { id: entry.id, title: entry.title, url: entry.url, fetchedAt: new Date().toISOString(), excerpt, byteCount: Buffer.byteLength(excerpt) };
  }
}
