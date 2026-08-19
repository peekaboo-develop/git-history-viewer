import { createRequire } from 'node:module';

const manifest = createRequire(import.meta.url)('../../package.json') as unknown;
const version = typeof manifest === 'object' && manifest !== null ? (manifest as { version?: unknown }).version : null;
const semver = /^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

if (typeof version !== 'string' || version.length > 128 || !semver.test(version)) throw new Error('Package manifest version is missing or invalid.');

export const PACKAGE_VERSION = version;
