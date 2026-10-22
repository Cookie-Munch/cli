/**
 * The `cookiemunch` CLI (CMN-30), driven end to end with a mocked fetch: every request it
 * sends is recorded, so each test says exactly what reached the API — and, for `diff`,
 * that nothing did.
 */
import { describe, it, expect } from 'vitest';
import { run } from '../src/cli.js';
import { harness, STORED, type Call } from './harness.js';
import { diffJson, mergeLikeServer } from '../src/diff.js';

const writes = (calls: Call[]) => calls.filter((c) => c.method !== 'GET' && !c.url.includes('dryRun=1')); // a server dry run stores nothing

describe('auth and usage', () => {
  it('refuses to run without COOKIEMUNCH_API_KEY', async () => {
    const h = harness({ env: { COOKIEMUNCH_API_KEY: '' } });
    expect(await run(['config', 'pull', '--site', 'acme'], h.io)).toBe(2);
    expect(h.err()).toMatch(/COOKIEMUNCH_API_KEY/);
    expect(h.calls).toEqual([]);
  });

  it('sends the key as a bearer token to the configured base URL', async () => {
    const h = harness();
    expect(await run(['config', 'pull', '--site', 'acme'], h.io)).toBe(0);
    expect(h.calls[0]).toMatchObject({ method: 'GET', url: 'https://api.test/v1/sites/acme/config', auth: 'Bearer fck_test' });
  });

  it('defaults to the hosted API', async () => {
    const h = harness({ env: { COOKIEMUNCH_BASE_URL: '' } });
    await run(['config', 'pull', '--site', 'acme'], h.io);
    expect(h.calls[0]!.url).toBe('https://api.cookiemunch.net/v1/sites/acme/config');
  });

  it('a missing --site, unknown command or bare flag is a usage error (exit 2)', async () => {
    for (const argv of [['config', 'pull'], ['frobnicate'], ['preview', '--site']]) {
      const h = harness();
      expect(await run(argv, h.io), argv.join(' ')).toBe(2);
    }
  });
});

describe('config pull', () => {
  it('prints the config as JSON', async () => {
    const h = harness();
    await run(['config', 'pull', '--site', 'acme'], h.io);
    expect(JSON.parse(h.out())).toEqual(STORED);
  });

  it('--out writes the file instead', async () => {
    const h = harness();
    await run(['config', 'pull', '--site', 'acme', '--out', 'cm.json'], h.io);
    expect(JSON.parse(h.written['cm.json']!)).toEqual(STORED);
    expect(h.out()).toBe('');
  });

  it('takes the site from COOKIEMUNCH_SITE', async () => {
    const h = harness({ env: { COOKIEMUNCH_SITE: 'acme' } });
    expect(await run(['config', 'pull'], h.io)).toBe(0);
  });
});

describe('config diff', () => {
  const edited = JSON.stringify({ banner: { content: { title: 'Your privacy' } }, defaultMode: 'opt-out' });

  it('shows what a push would change, and sends nothing', async () => {
    const h = harness({ files: { 'cm.json': edited } });
    expect(await run(['config', 'diff', '--site', 'acme', 'cm.json'], h.io)).toBe(0);
    expect(h.out()).toContain('~ banner.content.title: "Cookies" -> "Your privacy"');
    expect(h.out()).toContain('~ defaultMode: "opt-in" -> "opt-out"');
    // A merge keeps what the file leaves out — the body is not reported as removed.
    expect(h.out()).not.toContain('banner.content.body');
    expect(writes(h.calls), 'diff wrote to the API').toEqual([]);
  });

  it('--replace diffs against a whole-document replace', async () => {
    const h = harness({ files: { 'cm.json': edited } });
    await run(['config', 'diff', '--site', 'acme', 'cm.json', '--replace'], h.io);
    expect(h.out()).toContain('- banner.content.body');
    expect(h.out()).toContain('- geoRules');
  });

  it('--exit-code exits 1 when there are changes, 0 when there are none', async () => {
    const changed = harness({ files: { 'cm.json': edited } });
    expect(await run(['config', 'diff', '--site', 'acme', 'cm.json', '--exit-code'], changed.io)).toBe(1);
    const same = harness({ files: { 'cm.json': JSON.stringify(STORED) } });
    expect(await run(['config', 'diff', '--site', 'acme', 'cm.json', '--exit-code'], same.io)).toBe(0);
    expect(same.err()).toMatch(/No changes/);
  });

  it('a file that is not a JSON object is a usage error', async () => {
    for (const body of ['not json', '[1,2]', '"x"']) {
      const h = harness({ files: { 'cm.json': body } });
      expect(await run(['config', 'diff', '--site', 'acme', 'cm.json'], h.io), body).toBe(2);
    }
  });
});

describe('config diff --replace with a pulled file (Numestri 2026-10-22)', () => {
  // `config pull` output carries the server's read-only fields; the server drops them on a write.
  const READ_ONLY = { effective: { mode: 'opt-in' }, designWarnings: [], warnings: [], rightsFormUrl: 'https://x/r/acme', version: 3 };
  const pulled = JSON.stringify({ ...STORED, ...READ_ONLY });
  const withRO = (c: { url: string; method: string }) => (c.url.endsWith('/v1/sites/acme/config') && c.method === 'GET' ? { status: 200, body: { ...STORED, ...READ_ONLY } } : undefined);

  it('says "No changes" when only read-only fields differ (local fallback)', async () => {
    const h = harness({ files: { 'cm.json': pulled }, respond: withRO });
    expect(await run(['config', 'diff', '--site', 'acme', 'cm.json', '--replace', '--exit-code'], h.io)).toBe(0);
    expect(h.err()).toMatch(/No changes/);
    expect(h.out()).toBe('');
  });

  it('does not report a read-only field the file lacks as removed', async () => {
    const h = harness({ files: { 'cm.json': JSON.stringify(STORED) }, respond: withRO });
    await run(['config', 'diff', '--site', 'acme', 'cm.json', '--replace'], h.io);
    expect(h.out()).not.toMatch(/effective|rightsFormUrl|designWarnings/);
    expect(h.err()).toMatch(/No changes/);
  });

  it('takes the server\'s ?dryRun=1 diff as the source of truth', async () => {
    const h = harness({
      files: { 'cm.json': pulled },
      respond: (c) => (c.url.includes('dryRun=1') ? { status: 200, body: { dryRun: true, config: STORED, diff: [{ path: 'defaultMode', from: 'opt-in', to: 'opt-out' }, { path: 'geoRules', from: [1] }], designWarnings: [] } } : undefined),
    });
    expect(await run(['config', 'diff', '--site', 'acme', 'cm.json', '--replace', '--exit-code'], h.io)).toBe(1);
    expect(h.out()).toContain('~ defaultMode: "opt-in" -> "opt-out"');
    expect(h.out()).toContain('- geoRules');
    const dry = h.calls.find((c) => c.url.includes('dryRun=1'))!;
    expect(dry.method).toBe('PUT');
    expect(dry.body).not.toHaveProperty('effective');
    expect(writes(h.calls).filter((c) => !c.url.includes('dryRun=1'))).toEqual([]);
  });

  it('the server\'s empty dry-run diff is "No changes"', async () => {
    const h = harness({ files: { 'cm.json': pulled }, respond: (c) => (c.url.includes('dryRun=1') ? { status: 200, body: { dryRun: true, config: STORED, diff: [], designWarnings: [] } } : undefined) });
    expect(await run(['config', 'diff', '--site', 'acme', 'cm.json', '--replace'], h.io)).toBe(0);
    expect(h.err()).toMatch(/No changes/);
  });
});

describe('config push', () => {
  it('PATCHes the file (merge) and reports what changed', async () => {
    const h = harness({ files: { 'cm.json': JSON.stringify({ defaultMode: 'opt-out' }) } });
    expect(await run(['config', 'push', '--site', 'acme', 'cm.json'], h.io)).toBe(0);
    expect(writes(h.calls)).toEqual([
      expect.objectContaining({ method: 'PATCH', url: 'https://api.test/v1/sites/acme/config', body: { defaultMode: 'opt-out' } }),
    ]);
    expect(h.err()).toMatch(/Applied 1 change/);
  });

  it('--replace PUTs the whole document', async () => {
    const h = harness({ files: { 'cm.json': JSON.stringify({ defaultMode: 'opt-out' }) } });
    await run(['config', 'push', '--site', 'acme', 'cm.json', '--replace'], h.io);
    expect(writes(h.calls)).toEqual([expect.objectContaining({ method: 'PUT', body: { defaultMode: 'opt-out', cbid: 'acme' } })]);
  });

  it('sends nothing when the file changes nothing', async () => {
    const h = harness({ files: { 'cm.json': JSON.stringify(STORED) } });
    expect(await run(['config', 'push', '--site', 'acme', 'cm.json'], h.io)).toBe(0);
    expect(writes(h.calls)).toEqual([]);
  });

  it('an API refusal is exit 1 with the server’s reason', async () => {
    const h = harness({
      files: { 'cm.json': JSON.stringify({ defaultMode: 'bogus' }) },
      respond: (c) => (c.method === 'PATCH' ? { status: 400, body: { error: 'invalid defaultMode', code: 'bad_request' } } : undefined),
    });
    expect(await run(['config', 'push', '--site', 'acme', 'cm.json'], h.io)).toBe(1);
    expect(h.err()).toContain('API error 400 (bad_request): invalid defaultMode');
  });
});

describe('preview', () => {
  const minted = { cbid: 'acme', token: 't.s', expiresAt: 1_760_000_000_000, previewUrl: 'https://acme.com/?cm_preview=t.s&cm_region=eu&cm_lang=de' };
  const respond = (c: Call) => (c.url.endsWith('/preview-token') ? { status: 200, body: minted } : undefined);

  it('mints a token for the region + language and prints the link', async () => {
    const h = harness({ respond });
    expect(await run(['preview', '--site', 'acme', '--region', 'eu', '--lang', 'de', '--url', 'https://acme.com/', '--ttl', '600'], h.io)).toBe(0);
    expect(h.calls).toEqual([
      expect.objectContaining({ method: 'POST', url: 'https://api.test/v1/sites/acme/preview-token', body: { region: 'eu', lang: 'de', url: 'https://acme.com/', ttlSeconds: 600 } }),
    ]);
    expect(h.out()).toBe(`${minted.previewUrl}\n`);
    expect(h.opened).toEqual([]);
  });

  it('--open opens it', async () => {
    const h = harness({ respond });
    await run(['preview', '--site', 'acme', '--open'], h.io);
    expect(h.opened).toEqual([minted.previewUrl]);
  });

  it('rejects a lifetime the server would refuse, before asking', async () => {
    const h = harness({ respond });
    expect(await run(['preview', '--site', 'acme', '--ttl', '7200'], h.io)).toBe(2);
    expect(h.calls).toEqual([]);
  });
});

describe('executors test', () => {
  it('posts the email and operation to the connection’s test endpoint and prints the result', async () => {
    const result = { ok: true, operation: 'export', upstream: [{ status: 200 }] };
    const h = harness({ respond: (c) => (c.url.endsWith('/test') ? { status: 200, body: result } : undefined) });
    expect(await run(['executors', 'test', 'ex_1', '--email', 'jane@example.com', '--operation', 'export'], h.io)).toBe(0);
    expect(h.calls).toEqual([
      expect.objectContaining({ method: 'POST', url: 'https://api.test/v1/dsar/executors/ex_1/test', body: { email: 'jane@example.com', operation: 'export' }, auth: 'Bearer fck_test' }),
    ]);
    expect(JSON.parse(h.out())).toEqual(result);
  });

  it('defaults the operation to locate (the API\'s name), and needs an email', async () => {
    const h = harness({ respond: () => ({ status: 200, body: {} }) });
    await run(['executors', 'test', 'ex_1', '--email', 'a@b.co'], h.io);
    expect(h.calls[0]!.body).toEqual({ email: 'a@b.co', operation: 'locate' });
    expect(await run(['executors', 'test', 'ex_1'], harness().io)).toBe(2);
  });

  it('says so when the server has no test endpoint, rather than a bare 404', async () => {
    const h = harness();
    expect(await run(['executors', 'test', 'ex_1', '--email', 'a@b.co'], h.io)).toBe(1);
    expect(h.err()).toMatch(/does not offer connection tests yet/);
  });

  it('an unknown connection is reported as such', async () => {
    const h = harness({ respond: () => ({ status: 404, body: { error: 'connection not found', code: 'not_found' } }) });
    expect(await run(['executors', 'test', 'nope', '--email', 'a@b.co'], h.io)).toBe(1);
    expect(h.err()).toContain('connection not found');
  });
});

describe('executors webhook-test / deliveries', () => {
  it('sends the headers and the body file byte for byte, and prints the verdict; exit 1 when it does not verify', async () => {
    const body = '{ "type": "dsr.completed" }\n';
    const files = { 'h.json': '{"X-Sig":"v1,abc","X-Ts":"1"}', 'body.txt': body };
    const ok = harness({ files, respond: (c) => (c.url.endsWith('/webhook/test') ? { status: 200, body: { verified: true, stage: null, reason: null } } : undefined) });
    expect(await run(['executors', 'webhook-test', 'ex_1', '--headers-file', 'h.json', '--body-file', 'body.txt'], ok.io)).toBe(0);
    expect(ok.calls).toEqual([
      expect.objectContaining({ method: 'POST', url: 'https://api.test/v1/dsar/executors/ex_1/webhook/test', body: { headers: { 'X-Sig': 'v1,abc', 'X-Ts': '1' }, body } }),
    ]);
    expect(JSON.parse(ok.out())).toEqual({ verified: true, stage: null, reason: null });
    const bad = harness({ files, respond: () => ({ status: 200, body: { verified: false, stage: 'signature', reason: 'signature does not match' } }) });
    expect(await run(['executors', 'webhook-test', 'ex_1', '--headers-file', 'h.json', '--body-file', 'body.txt'], bad.io)).toBe(1);
    expect(await run(['executors', 'webhook-test', 'ex_1', '--headers-file', 'h.json'], harness({ files }).io)).toBe(2);
  });

  it('prints the delivery log', async () => {
    const h = harness({ respond: (c) => (c.url.endsWith('/webhook/deliveries') ? { status: 200, body: [{ id: 'd1', verified: false }] } : undefined) });
    expect(await run(['executors', 'deliveries', 'ex_1'], h.io)).toBe(0);
    expect(h.calls[0]).toEqual(expect.objectContaining({ method: 'GET', url: 'https://api.test/v1/dsar/executors/ex_1/webhook/deliveries' }));
    expect(JSON.parse(h.out())).toEqual([{ id: 'd1', verified: false }]);
  });
});

describe('the diff engine', () => {
  it('merges exactly like the server’s PATCH: objects merge, arrays replace', () => {
    expect(mergeLikeServer({ a: { x: 1, y: 2 }, l: [1, 2] }, { a: { y: 3 }, l: [9] })).toEqual({ a: { x: 1, y: 3 }, l: [9] });
  });

  it('removes a key sent as null, like the server (RFC 7386)', () => {
    expect(mergeLikeServer({ banner: { i18n: { es: { t: 'Hola' }, fr: { t: 'Salut' } } }, b: 1 }, { banner: { i18n: { es: null } }, b: null })).toEqual({
      banner: { i18n: { fr: { t: 'Salut' } } },
    });
    expect(mergeLikeServer({ a: 1 }, { n: { x: null, y: 2 } })).toEqual({ a: 1, n: { y: 2 } });
  });

  it('reports adds, removes and changes with paths', () => {
    expect(diffJson({ a: 1, b: { c: [1, 2] } }, { a: 2, b: { c: [1] }, d: true })).toEqual([
      { path: 'a', kind: 'changed', from: 1, to: 2 },
      { path: 'b.c[1]', kind: 'removed', from: 2 },
      { path: 'd', kind: 'added', to: true },
    ]);
  });
});

describe('executors presets / upgrade-preset / test --canary', () => {
  it('lists presets, and upgrades with --dry-run first', async () => {
    const h = harness({ respond: (c) => (c.url.endsWith('/presets') ? { status: 200, body: { canaryEmail: 'c@x', presets: [] } } : { status: 200, body: { dryRun: true, diff: [] } }) });
    expect(await run(['executors', 'presets'], h.io)).toBe(0);
    expect(await run(['executors', 'upgrade-preset', 'ex_1', '--dry-run', '--version', '1', '--atlas-id-app-id', 'app_1'], h.io)).toBe(0);
    expect(h.calls).toEqual([
      expect.objectContaining({ method: 'GET', url: 'https://api.test/v1/dsar/executors/presets' }),
      expect.objectContaining({ method: 'POST', url: 'https://api.test/v1/dsar/executors/ex_1/upgrade-preset?dryRun=1', body: { presetVersion: 1, atlasIdAppId: 'app_1' } }),
    ]);
    expect(await run(['executors', 'upgrade-preset', 'ex_1', '--version', 'two'], harness().io)).toBe(2);
  });

  it('--canary tests with the org canary and exits 1 when the connection is not ok', async () => {
    const bad = harness({ respond: () => ({ status: 200, body: { ok: false, code: 'base_url_redirects' } }) });
    expect(await run(['executors', 'test', 'ex_1', '--canary'], bad.io)).toBe(1);
    expect(bad.calls[0]!.body).toEqual({ canary: true, operation: 'locate' });
    const good = harness({ respond: () => ({ status: 200, body: { ok: true } }) });
    expect(await run(['executors', 'test', 'ex_1', '--canary'], good.io)).toBe(0);
    expect(await run(['executors', 'test', 'ex_1', '--canary', '--email', 'a@b.co'], harness().io)).toBe(2);
  });
});
