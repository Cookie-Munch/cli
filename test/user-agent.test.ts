import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { run, CLI_VERSION } from '../src/cli.js';
import { harness } from './harness.js';

type Seen = { headers?: Record<string, string> };

function withUa(env: Record<string, string> = {}) {
  const seen: Seen[] = [];
  const h = harness({ env });
  const inner = h.io.fetch;
  h.io.fetch = ((u: string, init?: RequestInit) => {
    seen.push({ headers: init?.headers as Record<string, string> });
    return inner(u, init);
  }) as typeof fetch;
  return { h, seen };
}

describe('User-Agent', () => {
  it('names the CLI and its version by default', async () => {
    const { h, seen } = withUa();
    await run(['config', 'pull', '--site', 'acme'], h.io);
    expect(seen[0]!.headers!['User-Agent']).toBe(`cookiemunch-cli/${CLI_VERSION}`);
  });
  it('the version is the package version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(CLI_VERSION).toBe(pkg.version);
  });
  it('COOKIEMUNCH_USER_AGENT overrides it', async () => {
    const { h, seen } = withUa({ COOKIEMUNCH_USER_AGENT: 'ci-bot/9' });
    await run(['config', 'pull', '--site', 'acme'], h.io);
    expect(seen[0]!.headers!['User-Agent']).toBe('ci-bot/9');
  });
  it('the raw requests send it too', async () => {
    const { h, seen } = withUa();
    await run(['executors', 'test', 'ex1', '--site', 'acme', '--canary'], h.io);
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) expect(s.headers!['User-Agent']).toBe(`cookiemunch-cli/${CLI_VERSION}`);
  });
});
