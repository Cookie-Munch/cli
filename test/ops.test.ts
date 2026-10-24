/** CMU-B15, D11, D12, S02: version, cookies/executors as files, dsar test, doctor, keys vend, plan/apply, exit codes. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { run, CLI_VERSION } from '../src/cli.js';
import { parseTtl } from '../src/ops.js';
import { harness, type Call } from './harness.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

describe('version (CMU-B15)', () => {
  it('--version prints the version and exits 0, without a key', async () => {
    const h = harness({ env: { COOKIEMUNCH_API_KEY: '' } });
    expect(await run(['--version'], h.io)).toBe(0);
    expect(h.out()).toBe(`${pkg.version}\n`);
    expect(CLI_VERSION).toBe(pkg.version);
    expect(h.calls).toHaveLength(0);
  });

  it('version --json adds the API version the server documents', async () => {
    const h = harness({ respond: (c) => (c.url.endsWith('/v1/openapi.json') ? { status: 200, body: { info: { version: '1.0.0' } } } : undefined) });
    expect(await run(['version', '--json'], h.io)).toBe(0);
    expect(JSON.parse(h.out())).toEqual({ cli: pkg.version, api: '1.0.0' });
  });
});

describe('cookies diff|push <file> (CMU-D11)', () => {
  const file = JSON.stringify({ cookies: [{ name: '_ga', category: 'statistics', purpose: 'Analytics' }] });
  it('diff asks the server dry run and changes nothing; push applies only when something differs', async () => {
    const respond = (c: Call) => {
      if (c.url.includes('/v1/sites/acme/cookies')) {
        const dry = c.url.includes('dryRun=1');
        return { status: 200, body: dry ? { dryRun: true, declared: [], saved: 0, removed: 0, diff: { added: [{ name: '_ga', category: 'statistics' }], removed: [], changed: [] } } : { declared: [], saved: 1, removed: 0 } };
      }
      return undefined;
    };
    const d = harness({ files: { 'c.json': file }, respond });
    expect(await run(['cookies', 'diff', 'c.json', '--site', 'acme', '--exit-code'], d.io)).toBe(1);
    expect(d.out()).toContain('+ _ga (statistics)');
    expect(d.calls.every((c) => c.url.includes('dryRun=1'))).toBe(true);
    const p = harness({ files: { 'c.json': file }, respond });
    expect(await run(['cookies', 'push', 'c.json', '--site', 'acme'], p.io)).toBe(0);
    expect(p.calls.map((c) => c.url.includes('dryRun=1'))).toEqual([true, false]);
  });

  it('a bad file is a usage mistake (exit 2)', async () => {
    const h = harness({ files: { 'c.json': '{"nope": 1}' } });
    expect(await run(['cookies', 'diff', 'c.json', '--site', 'acme'], h.io)).toBe(2);
  });
});

describe('executors pull|diff|push (CMU-D11)', () => {
  const current = [{ id: 'ex1', system: 'crm', baseUrl: 'https://crm.example', profile: { a: 1 }, auto: true, keyPrefix: 'sk_12345', hasWebhookSecret: true, createdAt: 1, webhookUrl: 'https://api/x', health: null }];
  const respond = (c: Call) => (c.url.endsWith('/v1/dsar/executors') && c.method === 'GET' ? { status: 200, body: current } : c.method === 'PATCH' ? { status: 200, body: current[0] } : c.method === 'POST' ? { status: 201, body: { id: 'ex2' } } : undefined);

  it('pull writes no secret, no key prefix and no state', async () => {
    const h = harness({ respond });
    expect(await run(['executors', 'pull', 'ex.json'], h.io)).toBe(0);
    const pulled = JSON.parse(h.written['ex.json']!);
    expect(pulled).toEqual({ executors: [{ id: 'ex1', system: 'crm', baseUrl: 'https://crm.example', profile: { a: 1 }, auto: true }] });
  });

  it('refuses a file carrying a secret; a new connection takes its key from --secret-env', async () => {
    const bad = harness({ respond, files: { 'e.json': JSON.stringify({ executors: [{ system: 'x', secretKey: 'oops' }] }) } });
    expect(await run(['executors', 'push', 'e.json'], bad.io)).toBe(2);
    const file = JSON.stringify({ executors: [{ id: 'ex1', system: 'crm', baseUrl: 'https://crm2.example', profile: { a: 1 }, auto: true }, { system: 'billing', baseUrl: 'https://b.example', preset: 'cm-standard-v1' }] });
    const noSecret = harness({ respond, files: { 'e.json': file } });
    expect(await run(['executors', 'push', 'e.json'], noSecret.io)).toBe(2);
    const ok = harness({ respond, files: { 'e.json': file }, env: { BILLING_KEY: 'bk_secret_value' } });
    expect(await run(['executors', 'push', 'e.json', '--secret-env', 'BILLING_KEY'], ok.io)).toBe(0);
    expect(ok.calls.find((c) => c.method === 'PATCH')?.body).toEqual({ baseUrl: 'https://crm2.example' });
    expect((ok.calls.find((c) => c.method === 'POST')?.body as { secretKey: string }).secretKey).toBe('bk_secret_value');
    expect(ok.out() + ok.err()).not.toContain('bk_secret_value');
  });
});

describe('dsar test (CMU-D11)', () => {
  it('files test requests with and without the cbid, and --cleanup deletes exactly the ids it created', async () => {
    let n = 0;
    const respond = (c: Call) => {
      if (c.method === 'POST' && c.url.endsWith('/v1/dsar')) return { status: 201, body: { request: { id: `t${++n}` } } };
      if (c.method === 'GET' && /\/v1\/dsar\/t\d$/.test(c.url)) return { status: 200, body: { id: c.url.split('/').pop(), status: 'received' } };
      if (c.method === 'DELETE') return { status: 204 };
      if (c.method === 'GET' && c.url.endsWith('/v1/dsar')) return { status: 200, body: [{ id: 'live-1' }, { id: 't1' }] };
      return undefined;
    };
    const h = harness({ respond });
    expect(await run(['dsar', 'test', '--types', 'access,deletion', '--with-cbid', '--without-cbid', '--site', 'acme', '--cleanup', '--json'], h.io)).toBe(0);
    const r = JSON.parse(h.out());
    expect(r.created.map((c: { id: string }) => c.id)).toEqual(['t1', 't2', 't3', 't4']);
    expect(h.calls.filter((c) => c.method === 'DELETE').map((c) => c.url.split('/').pop())).toEqual(['t1', 't2', 't3', 't4']);
    expect(h.calls.some((c) => c.method === 'GET' && c.url.endsWith('/v1/dsar'))).toBe(false); // never lists to clean up
    expect((h.calls.filter((c) => c.method === 'POST').map((c) => (c.body as { test: boolean; cbid?: string })))).toEqual([
      expect.objectContaining({ test: true, cbid: 'acme' }), expect.not.objectContaining({ cbid: 'acme' }),
      expect.objectContaining({ test: true, cbid: 'acme' }), expect.not.objectContaining({ cbid: 'acme' }),
    ]);
  });
});

describe('doctor (CMU-D11)', () => {
  it('fails (exit 1) when the key belongs to another org than the config names', async () => {
    const respond = (c: Call) => {
      if (c.url.endsWith('/v1/me')) return { status: 200, body: { orgId: 'org_a', orgName: 'A', keyPrefix: 'cookiemunch_live_org_x', unscoped: false } };
      if (c.url.endsWith('/v1/keys/self')) return { status: 200, body: { prefix: 'p', expiresAt: Date.now() + 90 * 86_400_000 } };
      if (c.url.includes('registry.npmjs.org')) return { status: 200, body: { version: pkg.version } };
      if (c.url.includes('/v1/integration-health')) return { status: 200, body: { ok: true, counts: { error: 0, warning: 0, notChecked: 0 }, checks: [] } };
      return undefined;
    };
    const ok = harness({ respond, env: { COOKIEMUNCH_ORG: 'org_a' } });
    expect(await run(['doctor', '--json'], ok.io)).toBe(0);
    const wrong = harness({ respond });
    expect(await run(['doctor', '--org', 'org_b'], wrong.io)).toBe(1);
    expect(wrong.out()).toContain("this key's org is org_a, not org_b");
  });
});

describe('keys vend (CMU-S02)', () => {
  it('parses the ttl and prints only the key on stdout', async () => {
    expect([parseTtl('1h'), parseTtl('30m'), parseTtl('600'), parseTtl('13h'), parseTtl('10s'), parseTtl('x')]).toEqual([3600, 1800, 600, null, null, null]);
    const h = harness({ respond: (c) => (c.url.endsWith('/v1/keys/vend') ? { status: 201, body: { key: 'cookiemunch_live_org_VENDED', prefix: 'p', expiresAt: 0, scopes: ['sites:read'], cbids: null } } : undefined) });
    expect(await run(['keys', 'vend', '--scopes', 'sites:read', '--ttl', '1h'], h.io)).toBe(0);
    expect(h.out()).toBe('cookiemunch_live_org_VENDED\n');
    expect(h.calls[0]!.body).toEqual({ scopes: ['sites:read'], ttlSeconds: 3600 });
    expect(await run(['keys', 'vend', '--scopes', 'sites:read', '--ttl', '2d'], harness().io)).toBe(2);
  });
});

describe('plan|apply cookiemunch.json (CMU-D12)', () => {
  const bundle = JSON.stringify({ site: { cbid: 'acme', name: 'Acme' }, config: { defaultMode: 'opt-in' }, cookies: [{ name: '_ga', category: 'statistics', purpose: 'p' }], webhooks: [{ url: 'https://h.example/a', events: ['consent.recorded'] }], partners: [] });
  const respond = (c: Call) => {
    if (c.url.includes('/v1/sites/acme?dryRun=1')) return { status: 200, body: { diff: [] } };
    if (c.url.includes('/v1/sites/acme/config') && c.url.includes('dryRun')) return { status: 200, body: { dryRun: true, diff: [] } };
    if (c.url.includes('/v1/sites/acme/cookies')) return { status: 200, body: { dryRun: true, diff: { added: [], removed: [], changed: [] } } };
    if (c.url.endsWith('/v1/webhooks')) return { status: 200, body: [{ id: 'w1', url: 'https://h.example/a', events: ['consent.recorded'] }] };
    if (c.url.endsWith('/v1/partner_links')) return { status: 200, body: [] };
    return undefined;
  };
  it('plan says No changes for every part when they match, and writes nothing', async () => {
    const h = harness({ files: { 'cookiemunch.json': bundle }, respond });
    expect(await run(['plan', 'cookiemunch.json', '--exit-code'], h.io)).toBe(0);
    for (const part of ['site', 'config', 'cookies', 'webhooks', 'partners']) expect(h.out()).toContain(`${part}: No changes`);
    expect(h.calls.filter((c) => c.method !== 'GET' && !c.url.includes('dryRun')).length).toBe(0);
  });

  it('refuses an unknown part, and refuses to create a webhook without --secrets-out', async () => {
    expect(await run(['plan', 'x.json'], harness({ files: { 'x.json': JSON.stringify({ site: { cbid: 'acme' }, nope: {} }) } }).io)).toBe(2);
    const b2 = JSON.stringify({ site: { cbid: 'acme' }, webhooks: [{ url: 'https://h.example/new', events: ['consent.recorded'] }] });
    const h = harness({ files: { 'b.json': b2 }, respond });
    expect(await run(['apply', 'b.json'], h.io)).toBe(2);
    expect(h.calls.some((c) => c.method === 'POST' && c.url.endsWith('/v1/webhooks'))).toBe(false);
  });
});
