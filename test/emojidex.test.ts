/** EmojiDex's CLI report: minted connections, per-entry secretEnv, comments, ${env:NAME}, one-line refusals, a pending JWKS. */
import { describe, it, expect } from 'vitest';
import { run, USAGE } from '../src/cli.js';
import { harness, type Call } from './harness.js';

const live = [{ id: 'ex1', system: 'forumulate', preset: 'forumulate', cbid: 'acme', auto: true, mint: { partner: 'forumulate' } }];
const respond = (c: Call) => (c.url.endsWith('/v1/dsar/executors') && c.method === 'GET' ? { status: 200, body: live } : c.method === 'POST' ? { status: 201, body: { id: 'exN' } } : c.method === 'PATCH' ? { status: 200, body: live[0] } : undefined);
const posts = (calls: Call[]) => calls.filter((c) => c.method === 'POST' && c.url.endsWith('/v1/dsar/executors')).map((c) => c.body as Record<string, unknown>);
const writes = (calls: Call[]) => calls.filter((c) => c.method !== 'GET' && !c.url.includes('dryRun'));

describe('executors push (CM-1, CM-5)', () => {
  it('a mintFrom entry needs no key and never carries one; a keyed one in the same file uses its own secretEnv', async () => {
    const file = JSON.stringify({ executors: [
      { system: 'chatly', preset: 'chatly', mintFrom: 'chatly', cbid: 'acme' },
      { system: 'crm', baseUrl: 'https://crm.example', preset: 'cm-standard-v2', secretEnv: 'CRM_KEY' },
      { system: 'billing', baseUrl: 'https://b.example', preset: 'cm-standard-v2' },
    ] });
    const h = harness({ respond, files: { 'e.json': file }, env: { CRM_KEY: 'crm_secret', FALLBACK: 'fb_secret' } });
    expect(await run(['executors', 'push', 'e.json', '--secret-env', 'FALLBACK'], h.io)).toBe(0);
    const [chatly, crm, billing] = posts(h.calls);
    expect(chatly).toEqual({ system: 'chatly', preset: 'chatly', mintFrom: 'chatly', cbid: 'acme' });
    expect(crm).toMatchObject({ system: 'crm', secretKey: 'crm_secret' });
    expect(crm).not.toHaveProperty('secretEnv');
    expect(billing).toMatchObject({ system: 'billing', secretKey: 'fb_secret' });
    // Minted only: no --secret-env needed at all.
    const only = harness({ respond, files: { 'e.json': JSON.stringify({ executors: [{ system: 'chatly', mintFrom: 'chatly' }] }) } });
    expect(await run(['executors', 'push', 'e.json'], only.io)).toBe(0);
    expect(posts(only.calls)[0]).not.toHaveProperty('secretKey');
  });

  it('every missing variable is named before anything is sent', async () => {
    const file = JSON.stringify({ executors: [{ system: 'crm', secretEnv: 'CRM_KEY' }, { system: 'billing' }, { system: 'chatly', mintFrom: 'chatly' }] });
    const h = harness({ respond, files: { 'e.json': file } });
    expect(await run(['executors', 'push', 'e.json'], h.io)).toBe(2);
    expect(h.err()).toContain('crm: CRM_KEY is not set');
    expect(h.err()).toContain('billing: needs its API key');
    expect(h.err()).not.toContain('chatly');
    expect(writes(h.calls)).toHaveLength(0);
  });

  it('an existing minted connection is not a perpetual mintFrom/secretEnv change', async () => {
    const file = JSON.stringify({ executors: [{ system: 'forumulate', preset: 'forumulate', mintFrom: 'forumulate', cbid: 'acme', auto: true, secretEnv: 'X' }] });
    const h = harness({ respond, files: { 'e.json': file } });
    expect(await run(['executors', 'diff', 'e.json', '--exit-code'], h.io)).toBe(0);
    const p = harness({ respond, files: { 'c.json': JSON.stringify({ site: { cbid: 'acme' }, executors: JSON.parse(file).executors }) } });
    expect(await run(['plan', 'c.json', '--exit-code'], p.io)).toBe(0);
    expect(p.out()).toContain('executors: No changes');
  });

  it('CM-21: a file saying params matches the presetParams the API serves; a second push changes nothing', async () => {
    const lucida = [{ id: 'ex2', system: 'lucida', preset: 'lucida', cbid: 'acme', auto: true, presetParams: { projectId: 'p1', baseUrl: 'https://lucidace.com' }, mint: { partner: 'lucida', externalId: 'p1' } }];
    const r = (c: Call) => (c.url.endsWith('/v1/dsar/executors') && c.method === 'GET' ? { status: 200, body: lucida } : undefined);
    const file = JSON.stringify({ executors: [{ system: 'lucida', preset: 'lucida', params: { projectId: 'p1' }, mintFrom: 'lucida', externalId: 'p1', cbid: 'acme', auto: true }] });
    const h = harness({ respond: r, files: { 'e.json': file } });
    expect(await run(['executors', 'push', 'e.json'], h.io)).toBe(0);
    expect(h.err()).toContain('No changes');
    expect(writes(h.calls)).toHaveLength(0);
  });

  it('CM-20: mintFrom on a connection holding a pasted key is a change, sent as a PATCH with its account', async () => {
    const pasted = [{ id: 'ex3', system: 'lucida', preset: 'lucida', cbid: 'acme', auto: true, presetParams: { projectId: 'p1' } }];
    const r = (c: Call) => (c.url.endsWith('/v1/dsar/executors') && c.method === 'GET' ? { status: 200, body: pasted } : c.method === 'PATCH' ? { status: 200, body: pasted[0] } : undefined);
    const file = JSON.stringify({ executors: [{ system: 'lucida', preset: 'lucida', params: { projectId: 'p1' }, mintFrom: 'lucida', externalId: 'p1', cbid: 'acme', auto: true }] });
    const h = harness({ respond: r, files: { 'e.json': file } });
    expect(await run(['executors', 'push', 'e.json'], h.io)).toBe(0);
    expect(writes(h.calls).map((c) => [c.method, c.body])).toEqual([['PATCH', { mintFrom: 'lucida', externalId: 'p1' }]]);
  });

  it('apply checks an executor key before writing any other part', async () => {
    const b = JSON.stringify({ site: { cbid: 'acme' }, dsar: { graceDays: 14 }, executors: [{ system: 'crm', secretEnv: 'CRM_KEY' }] });
    const h = harness({ files: { 'c.json': b }, respond: (c) => (c.url.endsWith('/dsar-settings') ? { status: 200, body: { cbid: 'acme', graceDays: 7, source: 'site' } } : respond(c)) });
    expect(await run(['apply', 'c.json'], h.io)).toBe(2);
    expect(h.err()).toContain('CRM_KEY is not set');
    expect(writes(h.calls)).toHaveLength(0);
  });
});

describe('comments and ${env:NAME} (CM-6, CM-7)', () => {
  it('drops _ and x- keys at every level, and expands ${env:NAME} only', async () => {
    const file = JSON.stringify({ _note: 'hi', executors: [{ _key: 'why', 'x-owner': 'ops', system: 'crm', baseUrl: '${env:CRM_URL}/api', cbid: '${CBID}', presetParams: { _x: 1, programId: 'prg_${env:PROG}' }, secretEnv: 'CRM_KEY' }] });
    const h = harness({ respond, files: { 'e.json': file }, env: { CRM_URL: 'https://crm.example', PROG: '7', CRM_KEY: 'k' } });
    expect(await run(['executors', 'push', 'e.json'], h.io)).toBe(0);
    expect(posts(h.calls)[0]).toEqual({ system: 'crm', baseUrl: 'https://crm.example/api', cbid: '${CBID}', presetParams: { _x: 1, programId: 'prg_7' }, secretKey: 'k' });
  });

  it('never strips nested keys: config maps and executor params keep _ga, _x and x- names', async () => {
    const config = { someMap: { _ga: 'analytics', 'x-forwarded-for': 'h' } };
    const b = JSON.stringify({ site: { cbid: 'acme' }, config, executors: [{ system: 'crm', mintFrom: 'crm', params: { _x: 1, 'x-key': 'v' } }] });
    const h = harness({ files: { 'c.json': b }, respond: (c) => (c.url.includes('/config') ? { status: 200, body: { dryRun: true, diff: [{ path: 'someMap._ga', from: null, to: 'analytics' }] } } : respond(c)) });
    expect(await run(['apply', 'c.json'], h.io)).toBe(0);
    expect(h.calls.find((c) => c.method === 'PATCH' && c.url.endsWith('/config'))?.body).toEqual(config);
    expect(posts(h.calls)[0]).toEqual({ system: 'crm', mintFrom: 'crm', params: { _x: 1, 'x-key': 'v' } });
  });

  it('an unset ${env:NAME} fails before anything is sent, naming it', async () => {
    const h = harness({ respond, files: { 'e.json': JSON.stringify({ executors: [{ system: 'crm', baseUrl: '${env:NOPE}' }] }) } });
    expect(await run(['executors', 'diff', 'e.json'], h.io)).toBe(2);
    expect(h.err()).toContain('executors[0].baseUrl: ${env:NOPE} is not set');
    const b = harness({ files: { 'c.json': JSON.stringify({ site: { cbid: 'acme' }, dsar: { graceDays: '${env:NOPE}' } }) } });
    expect(await run(['plan', 'c.json'], b.io)).toBe(2);
    expect(b.calls).toHaveLength(0);
  });

  it('a top-level _note in cookiemunch.json is a comment, not an unknown part', async () => {
    const b = JSON.stringify({ _note: 'x', 'x-team': 'y', site: { cbid: 'acme', _why: 'z' }, dsar: { graceDays: '${env:GRACE}' } });
    const h = harness({ files: { 'c.json': b }, env: { GRACE: '14' }, respond: (c) => (c.url.endsWith('/dsar-settings') ? { status: 200, body: { cbid: 'acme', graceDays: 7, source: 'site' } } : undefined) });
    expect(await run(['apply', 'c.json'], h.io)).toBe(0);
    expect(h.calls.find((c) => c.method === 'PUT')?.body).toEqual({ graceDays: '14' });
  });
});

describe('a refusal is one line, a wrong invocation gets the help', () => {
  it('a missing key prints its message without the usage block; a missing file positional still prints it', async () => {
    const h = harness({ respond, files: { 'e.json': JSON.stringify({ executors: [{ system: 'billing' }] }) } });
    expect(await run(['executors', 'push', 'e.json'], h.io)).toBe(2);
    expect(h.err()).not.toContain(USAGE);
    expect(h.err().trim().split('\n')).toHaveLength(1);
    const u = harness({ respond });
    expect(await run(['executors', 'push'], u.io)).toBe(2);
    expect(u.err()).toContain(USAGE);
  });
});

describe('a rightsIdentity key set not live yet (CM-2)', () => {
  const identity = { type: 'custom', issuer: 'https://auth.emojidex.example', jwksUrl: 'https://emojidex.example/.well-known/jwks.json' };
  const b = JSON.stringify({ site: { cbid: 'acme' }, rightsIdentity: identity, dsar: { graceDays: 14 } });
  const r = (c: Call) => {
    if (c.url.includes('/rights-identity')) return { status: 424, body: { error: `the key set at ${identity.jwksUrl} could not be fetched`, code: 'identity_jwks_unreachable' } };
    if (c.url.endsWith('/dsar-settings')) return { status: 200, body: c.method === 'GET' ? { cbid: 'acme', graceDays: 7, source: 'site' } : { cbid: 'acme', graceDays: 14 } };
    return undefined;
  };
  it('plan reports only that part as pending, and exits 3', async () => {
    const h = harness({ files: { 'c.json': b }, respond: r });
    expect(await run(['plan', 'c.json'], h.io)).toBe(3);
    expect(h.out()).toContain(`pending: waiting on a live site: ${identity.jwksUrl} not reachable yet; re-run apply after deploy`);
    expect(h.out()).toContain('dsar: 1 change(s)');
  });
  it('apply applies every other part, skips it, and exits 3', async () => {
    const h = harness({ files: { 'c.json': b }, respond: r });
    expect(await run(['apply', 'c.json'], h.io)).toBe(3);
    expect(writes(h.calls).map((c) => c.url)).toEqual(['https://api.test/v1/sites/acme/dsar-settings']);
    expect(h.err()).toContain('rightsIdentity: pending');
  });
  it('another error still stops the run', async () => {
    const h = harness({ files: { 'c.json': b }, respond: (c) => (c.url.includes('/rights-identity') ? { status: 422, body: { error: 'bad', code: 'identity_jwks_invalid' } } : r(c)) });
    expect(await run(['apply', 'c.json'], h.io)).toBe(1);
    expect(writes(h.calls)).toHaveLength(0);
  });
});

describe('Upcify CM-U1: a flag a command does not take', () => {
  it('names the positional file, prints the command usage only', async () => {
    const h = harness({});
    expect(await run(['plan', '--file', 'x.json'], h.io)).toBe(2);
    const lines = h.err().trim().split('\n');
    expect(lines.length).toBeLessThanOrEqual(2);
    expect(lines[0]).toBe('plan does not take --file: the file is positional (cookiemunch plan x.json)');
    expect(lines[1]).toMatch(/^usage: cookiemunch plan /);
  });
});

describe('Upcify CM-U6: a www twin in aliases', () => {
  it('is left out of the plan with a note, not a failed plan', async () => {
    const sent: unknown[] = [];
    const r = (c: Call) => {
      if (c.url.includes('/v1/sites/acme') && c.method === 'PATCH') {
        sent.push(c.body);
        const aliases = (c.body as { aliases?: string[] }).aliases ?? [];
        if (aliases.includes('www.acme.com')) return { status: 400, body: { error: 'www.acme.com needs no alias: the site\'s domain and its www/apex twin are always covered. Remove it from aliases.', code: 'alias_is_domain', field: 'aliases' } };
        return { status: 200, body: { dryRun: true, diff: [] } };
      }
      return undefined;
    };
    const h = harness({ respond: r, files: { 'c.json': JSON.stringify({ site: { cbid: 'acme', aliases: ['www.acme.com', 'shop.acme.com'] } }) } });
    expect(await run(['plan', 'c.json'], h.io)).toBe(0);
    expect(h.out()).toContain('aliases: www.acme.com left out');
    expect(sent.at(-1)).toEqual({ aliases: ['shop.acme.com'] });
  });
});

describe('pdfofile C4: rows the vendor declared itself', () => {
  it('get one summary line, not a "your own row" warning each', async () => {
    const skipped = ['cf_anon', 'cflx_cred', 'fx_ab'].map((name) => ({ name, reason: "kept: Forumulate's own row on this site (the same provider the preset names)" }));
    const r = (c: Call) => (c.url.includes('/cookies/presets/forumulate') ? { status: 200, body: { dryRun: true, diff: { added: [], removed: [], changed: [] }, upstream: { applied: 'x', latest: 'x' }, skipped } } : undefined);
    const h = harness({ respond: r, files: { 'c.json': JSON.stringify({ site: { cbid: 'acme' }, presets: [{ vendor: 'forumulate' }] }) } });
    expect(await run(['plan', 'c.json'], h.io)).toBe(0);
    expect(h.out()).toContain('3 row(s) forumulate declared on this site itself are kept as they are: cf_anon, cflx_cred, fx_ab');
    expect(h.out()).not.toContain('your own row');
  });
});

describe('pdfofile C1: a file with only site.domain', () => {
  const file = JSON.stringify({ site: { domain: 'pdf.example' } });
  it('plan shows the create and exits 1 under --exit-code; nothing is created', async () => {
    const h = harness({ files: { 'c.json': file }, respond: (c) => (c.url.endsWith('/v1/sites') && c.method === 'GET' ? { status: 200, body: [] } : undefined) });
    expect(await run(['plan', 'c.json', '--exit-code'], h.io)).toBe(1);
    expect(h.out()).toContain('site: + create site pdf.example');
    expect(h.calls.some((c) => c.method === 'POST')).toBe(false);
  });
  it('apply creates the site, writes its cbid into the file, and goes on', async () => {
    const h = harness({ files: { 'c.json': file }, respond: (c) => (c.url.endsWith('/v1/sites') && c.method === 'GET' ? { status: 200, body: [] } : c.url.endsWith('/v1/sites') && c.method === 'POST' ? { status: 201, body: { cbid: 'new-1', domain: 'pdf.example' } } : c.url.includes('/v1/sites/new-1') ? { status: 200, body: { cbid: 'new-1', domain: 'pdf.example' } } : undefined) });
    await run(['apply', 'c.json'], h.io);
    expect(h.calls.find((c) => c.method === 'POST' && c.url.endsWith('/v1/sites'))!.body).toMatchObject({ domain: 'pdf.example' });
    expect(JSON.parse(h.written['c.json']!)).toEqual({ site: { domain: 'pdf.example', cbid: 'new-1' } });
    expect(h.err()).toContain('created site for pdf.example: new-1');
  });
  it('an existing site for the domain (or its www twin) is used, not duplicated', async () => {
    const h = harness({ files: { 'c.json': file }, respond: (c) => (c.url.endsWith('/v1/sites') && c.method === 'GET' ? { status: 200, body: [{ cbid: 'old-1', domain: 'www.pdf.example' }] } : c.url.includes('/v1/sites/old-1') ? { status: 200, body: { cbid: 'old-1', domain: 'www.pdf.example' } } : undefined) });
    await run(['plan', 'c.json'], h.io);
    expect(h.err()).toContain('planning against old-1');
    expect(h.calls.some((c) => c.method === 'POST')).toBe(false);
  });
});
