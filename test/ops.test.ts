/** CMU-B15, D11, D12, S02: version, cookies/executors as files, dsar test, doctor, keys vend, plan/apply, exit codes. */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { run, BOOLEAN_FLAGS, CLI_VERSION, USAGE, COMMAND_FLAGS, flagNotTaken, strayWord } from '../src/cli.js';
import { parseTtl, systemFromUrl } from '../src/ops.js';
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

  it('with --site names a preset the site writes more than it declares, as a warning, not a failure', async () => {
    const h = harness({
      respond: (c) => {
        if (c.url.endsWith('/v1/me')) return { status: 200, body: { orgId: 'org_a', keyPrefix: 'p' } };
        if (c.url.endsWith('/v1/keys/self')) return { status: 200, body: { prefix: 'p' } };
        if (c.url.includes('registry.npmjs.org')) return { status: 200, body: { version: pkg.version } };
        if (c.url.includes('/v1/integration-health')) return { status: 200, body: { ok: true, counts: { error: 0, warning: 0, notChecked: 0 }, checks: [] } };
        if (c.url.endsWith('/v1/sites/acme/cookies/presets')) return { status: 200, body: { presets: [
          { vendor: 'atlas', applied: true, declared: ['__atlas_rt'], incomplete: ['__session'], params: [], manifest: {} },
          { vendor: 'chatly', applied: false, declared: [], params: [], manifest: {} },
        ] } };
        return undefined;
      },
    });
    expect(await run(['doctor', '--site', 'acme'], h.io)).toBe(0);
    expect(h.out()).toContain('--   preset atlas: preset_incomplete: seen but not declared: __session');
    expect(h.out()).not.toContain('preset chatly');
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

  it('plan reports a config field the server\'s dry run does not keep, instead of No changes', async () => {
    const b = JSON.stringify({ site: { cbid: 'acme' }, config: { consent: { identifyIssuers: [{ issuer: 'https://forumulate.com', jwksUrl: 'https://forumulate.com/k' }] } } });
    const h = harness({ files: { 'b.json': b }, respond: (c) => (c.url.includes('/config') ? { status: 200, body: { dryRun: true, diff: [], config: { cbid: 'acme', consent: { version: 1 } } } } : respond(c)) });
    expect(await run(['plan', 'b.json', '--exit-code'], h.io)).toBe(1);
    expect(h.out()).toContain("not applied: consent.identifyIssuers (the server's dry run does not keep it)");
    expect(h.err()).not.toContain('No changes: all');
  });

  it('refuses an unknown part, and refuses to create a webhook without --secrets-out', async () => {
    expect(await run(['plan', 'x.json'], harness({ files: { 'x.json': JSON.stringify({ site: { cbid: 'acme' }, nope: {} }) } }).io)).toBe(2);
    const b2 = JSON.stringify({ site: { cbid: 'acme' }, webhooks: [{ url: 'https://h.example/new', events: ['consent.recorded'] }] });
    const h = harness({ files: { 'b.json': b2 }, respond });
    expect(await run(['apply', 'b.json'], h.io)).toBe(2);
    expect(h.calls.some((c) => c.method === 'POST' && c.url.endsWith('/v1/webhooks'))).toBe(false);
  });

  it('creates a webhook with the secret its secretEnv names, and never takes one from the file (Calendoro #14)', async () => {
    const b3 = JSON.stringify({ site: { cbid: 'acme' }, webhooks: [{ url: 'https://h.example/new', events: ['consent.*'], secretEnv: 'HOOK_SECRET' }] });
    const chosen = 'x'.repeat(40);
    const h = harness({ files: { 'b.json': b3 }, env: { HOOK_SECRET: chosen }, respond: (c) => (c.method === 'POST' && c.url.endsWith('/v1/webhooks') ? { status: 201, body: { id: 'w2', url: 'https://h.example/new', events: ['consent.*'] } } : respond(c)) });
    expect(await run(['apply', 'b.json'], h.io)).toBe(0);
    expect(h.calls.find((c) => c.method === 'POST' && c.url.endsWith('/v1/webhooks'))!.body).toMatchObject({ events: ['consent.*'], secret: chosen });
    const b4 = JSON.stringify({ site: { cbid: 'acme' }, webhooks: [{ url: 'https://h.example/new', events: ['consent.*'], secret: chosen }] });
    expect(await run(['apply', 'b.json'], harness({ files: { 'b.json': b4 }, respond }).io)).toBe(2);
  });
});

describe('executors connect (one route)', () => {
  it('mints through the partner and says the scope', async () => {
    const h = harness({ respond: (c) => (c.url.includes('/v1/dsar/executors') ? { status: 201, body: { id: 'e1', system: 'chatly' } } : undefined) as never });
    expect(await run(['executors', 'connect', 'chatly', '--site', 'c1', '--external-id', 'ws1'], h.io)).toBe(0);
    expect(h.calls.find((c) => c.method === 'POST')!.body).toEqual({ preset: 'chatly', cbid: 'c1', mintFrom: 'chatly', externalId: 'ws1' });
    expect(h.out()).toMatch(/Scoped to c1/);
  });

  it('a refused mint ends in the human step and the command to run after it', async () => {
    const h = harness({ respond: (c) => (c.url.includes('/v1/dsar/executors') ? { status: 424, body: { error: 'Chatly answered 403 (no_attributable_owner)', code: 'partner_mint_failed', humanStep: 'sign in to chatly' } } : undefined) as never });
    expect(await run(['executors', 'connect', 'chatly', '--site', 'c1'], h.io)).toBe(1);
    expect(h.err()).toMatch(/Do this: sign in to chatly/);
    expect(h.err()).toMatch(/--key-env CHATLY_KEY/);
  });

  it('--key-env sends the key, and a dry run stores nothing', async () => {
    const h = harness({ env: { CK: 'sk_abc' }, respond: (c) => (c.url.includes('/v1/dsar/executors') ? { status: 200, body: { dryRun: true, executor: {}, diff: [] } } : undefined) as never });
    expect(await run(['executors', 'connect', 'chatly', '--site', 'c1', '--key-env', 'CK', '--dry-run'], h.io)).toBe(0);
    const post = h.calls.find((c) => c.method === 'POST')!;
    expect(post.url).toContain('dryRun=1');
    expect(post.body).toEqual({ preset: 'chatly', cbid: 'c1', secretKey: 'sk_abc' });
  });
});

describe('plan: preset drift', () => {
  const bundle = (pinned = false) => JSON.stringify({ site: { cbid: 'c1' }, presets: [{ vendor: 'atlas', ...(pinned ? { pinned: true } : {}) }] });
  const drifted = (c: Call) => (c.url.includes('/cookies/presets/atlas') ? { status: 200, body: { dryRun: true, diff: { added: ['__session'], removed: [], changed: [] }, upstream: { applied: '2026-10-01', latest: '2026-11-05' } } } : undefined);

  it('names the move, lists rows with --detail, and exits 3 when only presets drifted', async () => {
    const h = harness({ files: { 'c.json': bundle() }, respond: drifted as never });
    expect(await run(['plan', 'c.json', '--detail', '--exit-code'], h.io)).toBe(3);
    expect(h.out()).toMatch(/preset atlas: 1 declaration change\(s\) \(manifest 2026-10-01 -> 2026-11-05\)/);
    expect(h.out()).toMatch(/\+ atlas: __session/);
  });

  it('a pinned preset is reported, is not a change, and exits 0', async () => {
    const h = harness({ files: { 'c.json': bundle(true) }, respond: drifted as never });
    expect(await run(['plan', 'c.json', '--exit-code'], h.io)).toBe(0);
    expect(h.out()).toMatch(/pinned, 1 upstream change\(s\) not followed/);
  });
});

describe('conformance output', () => {
  it('prints the fix first and hides blocked rows', async () => {
    const report = { conformance: true, canary: true, email: 'x', ok: false, passed: 1, failed: 1, skipped: 0, blocked: 13, code: 'missing_scope', required: ['privacy:execute'], fix: 'It needs privacy:execute.', rules: [
      { id: 'auth.required', title: 't', status: 'pass' }, { id: 'lookup.email.found', title: 't', status: 'fail', detail: 'HTTP 403' }, { id: 'version.header', title: 't', status: 'blocked', blockedBy: 'lookup.email.found' },
    ] };
    const h = harness({ respond: (c) => (c.url.includes('/test') ? { status: 200, body: report } : undefined) as never });
    expect(await run(['executors', 'conformance', '--connection', 'e1'], h.io)).toBe(1);
    expect(h.out().startsWith('FIX: It needs privacy:execute.')).toBe(true);
    expect(h.out()).not.toMatch(/version\.header/);
    expect(h.out()).toMatch(/13 blocked by the failure above/);
  });
});

describe('init and doctor --fix-plan', () => {
  it('init detects Next, writes the file and prints the lines to add', async () => {
    const h = harness({ files: { 'package.json': JSON.stringify({ dependencies: { next: '15' } }) } });
    expect(await run(['init', '--site', 'c1'], h.io)).toBe(0);
    expect(JSON.parse(h.written['cookiemunch.json']!).site.cbid).toBe('c1');
    expect(h.out()).toMatch(/CookieMunchScript cbid="c1"/);
  });

  it('--fix-plan lists the open steps in order', async () => {
    const h = harness({ respond: (c) => {
      if (c.url.endsWith('/v1/me')) return { status: 200, body: { orgId: 'o', rights: { warningDetails: [{ code: 'chatly_no_connection', message: 'm', fix: 'Connect Chatly.', requiredScopes: ['privacy:execute'] }] } } };
      if (c.url.endsWith('/v1/dsar/executors')) return { status: 200, body: [{ id: 'e1', system: 'mine', state: 'awaiting_first_probe' }] };
      return { status: 500, body: {} };
    } });
    await run(['doctor', '--fix-plan'], h.io);
    expect(h.out()).toMatch(/1\. Connect Chatly\. \(this key lacks privacy:execute\)\n2\. Deploy mine's rights API, then: cookiemunch executors activate e1/);
  });
});

describe('preview --screenshot', () => {
  const token = (c: Call) => (c.url.includes('/preview') ? { status: 200, body: { token: 't', previewUrl: 'https://a.example/?cm_preview=t', expiresAt: 1 } } : undefined);
  it('saves the page, and a missing browser says how to get one', async () => {
    const h = harness({ respond: token as never });
    const shots: string[] = [];
    h.io.screenshot = async (u, p) => { shots.push(`${u} ${p}`); };
    expect(await run(['preview', '--site', 'c1', '--url', 'https://a.example', '--screenshot', 'b.png'], h.io)).toBe(0);
    expect(shots).toEqual(['https://a.example/?cm_preview=t b.png']);
    h.io.screenshot = async () => { throw new Error('no chromium'); };
    expect(await run(['preview', '--site', 'c1', '--url', 'https://a.example', '--screenshot', 'b.png'], h.io)).toBe(1);
    expect(h.err()).toMatch(/playwright install chromium/);
  });
});

describe('doctor --fix-plan says what applies', () => {
  const withMe = (me: object) => harness({ respond: (c) => (c.url.endsWith('/v1/me') ? { status: 200, body: { orgId: 'o', rights: { warningDetails: [{ code: 'no_controller', message: 'm', fix: 'PUT /v1/org/controller.', cbids: ['other'], requiredScopes: ['rights:write'] }] }, ...me } } : { status: 500, body: {} }) });
  it('a full-access key is not told it needs a scope, and a step about another site is left out', async () => {
    const full = withMe({ unscoped: true });
    await run(['doctor', '--fix-plan'], full.io);
    expect(full.out()).toMatch(/other: PUT \/v1\/org\/controller\.\n/);
    const here = withMe({ unscoped: true });
    await run(['doctor', '--site', 'mine', '--fix-plan'], here.io);
    expect(here.out()).not.toMatch(/PUT \/v1\/org\/controller/);
  });
});

describe('ForgeDeck retest: commands that said success', () => {
  const executors = (c: Call, post: unknown) => (c.url.includes('/v1/dsar/executors') ? (c.method === 'GET' ? { status: 200, body: [] } : post) : undefined);

  it('connect checks the key: a refusal stores nothing and exits 1; a good key says what it found', async () => {
    const bad = harness({ env: { K: 'fake_key_value_123' }, respond: ((c: Call) => executors(c, { status: 422, body: { error: 'the probe failed, so nothing was stored: unauthorized', code: 'verify_failed', verify: {} } })) as never });
    expect(await run(['executors', 'connect', 'referalli', '--site', 'c1', '--key-env', 'K'], bad.io)).toBe(1);
    expect(bad.calls.find((c) => c.method === 'POST')!.url).toMatch(/verify=1/);
    expect(bad.err()).toMatch(/nothing was stored/);
    expect(bad.out()).not.toMatch(/Connected/);
    const good = harness({ env: { K: 'real_key_value_123' }, respond: ((c: Call) => executors(c, { status: 201, body: { id: 'e1', system: 'referalli', verify: { verdict: 'the key works' } } })) as never });
    expect(await run(['executors', 'connect', 'referalli', '--site', 'c1', '--key-env', 'K'], good.io)).toBe(0);
    expect(good.out()).toMatch(/Connected referalli[\s\S]*the key works/);
  });

  it('--defer registers it pending and does not say connected; --no-verify warns; --base-url and --system are sent', async () => {
    const created = (c: Call) => executors(c, { status: 201, body: { id: 'e1', system: 'x' } });
    const d = harness({ env: { K: 'real_key_value_123' }, respond: created as never });
    expect(await run(['executors', 'connect', 'referalli', '--site', 'c1', '--key-env', 'K', '--defer'], d.io)).toBe(0);
    expect(d.calls.find((c) => c.method === 'POST')!.body).toMatchObject({ state: 'pending' });
    expect(d.out()).toMatch(/not connected yet/);
    const n = harness({ env: { K: 'real_key_value_123' }, respond: created as never });
    expect(await run(['executors', 'connect', 'cm-standard-v2', '--site', 'c1', '--key-env', 'K', '--no-verify', '--base-url', 'https://a.example/x', '--system', 'mine'], n.io)).toBe(0);
    const post = n.calls.find((c) => c.method === 'POST')!;
    expect(post.url).not.toMatch(/verify/);
    expect(post.body).toMatchObject({ baseUrl: 'https://a.example/x', system: 'mine' });
    expect(n.err()).toMatch(/not checked/);
  });

  it('cm-standard-v2 with only --base-url is named after its host', async () => {
    const h = harness({ env: { K: 'real_key_value_123' }, respond: ((c: Call) => executors(c, { status: 200, body: { dryRun: true, executor: {}, diff: [] } })) as never });
    expect(await run(['executors', 'connect', 'cm-standard-v2', '--site', 'c1', '--key-env', 'K', '--base-url', 'https://example.com/x', '--dry-run'], h.io)).toBe(0);
    expect(h.calls.find((c) => c.method === 'POST')!.body).toMatchObject({ baseUrl: 'https://example.com/x', system: 'example' });
  });

  it('a missing base URL names the flag', async () => {
    const h = harness({ env: { K: 'real_key_value_123' }, respond: ((c: Call) => executors(c, { status: 400, body: { error: 'baseUrl required', field: 'baseUrl', acceptedFields: ['baseUrl'] } })) as never });
    expect(await run(['executors', 'connect', 'cm-standard-v2', '--site', 'c1', '--key-env', 'K'], h.io)).toBe(1);
    expect(h.err()).toMatch(/--base-url/);
  });

  it('a name already taken names the connection and a command that can succeed, without trying to mint', async () => {
    const h = harness({ respond: ((c: Call) => (c.url.includes('/v1/dsar/executors') ? { status: 200, body: [{ id: 'e1', system: 'chatly', cbid: 'siteA' }] } : undefined)) as never });
    expect(await run(['executors', 'connect', 'chatly', '--site', 'siteB'], h.io)).toBe(1);
    expect(h.err()).toMatch(/e1, site siteA/);
    expect(h.err()).toMatch(/--site siteB --system chatly-2/);
    expect(h.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('flags: unknown is refused by name, a renamed one says what to use, a known one the command ignores is refused', async () => {
    const h = harness({ env: { K: 'real_key_value_123' } });
    expect(await run(['executors', 'connect', 'referalli', '--site', 'c1', '--notaflag', '--dry-run'], h.io)).toBe(2);
    expect(h.err()).toMatch(/unknown flag --notaflag/);
    const r = harness();
    expect(await run(['executors', 'connect', 'referalli', '--cbid', 'c1'], r.io)).toBe(2);
    expect(r.err()).toMatch(/unknown flag --cbid: use --site/);
    const k = harness();
    expect(await run(['init', '--domain', 'a.example', '--defer'], k.io)).toBe(2);
    expect(k.err()).toMatch(/init .*does not take --defer/);
  });

  it('every flag the source reads is one the help names, or it would be refused', () => {
    const dir = new URL('../src/', import.meta.url);
    const src = ['cli.ts', 'ops.ts', 'integrations.ts', 'rights-page.ts', 'source.ts'].map((f) => readFileSync(new URL(f, dir), 'utf8')).join('');
    const used = [...src.matchAll(/(?:flag\(|str\(h, |str\(p\.flags, |str\(flags, )'([a-z-]+)'/g)].map((m) => m[1]!);
    expect(used.filter((f) => !USAGE.includes(`--${f}`) && f !== 'help')).toEqual([]);
  });

  it('init refuses a junk domain before any call, even on a dry run', async () => {
    for (const extra of [[], ['--dry-run']]) {
      const h = harness();
      expect(await run(['init', '--domain', 'not a domain', ...extra], h.io)).toBe(2);
      expect(h.err()).toMatch(/--domain must be a hostname/);
      expect(h.calls).toEqual([]);
      expect(h.written).toEqual({});
    }
  });

  it('init reuses the site with that domain, and leaves an existing file alone', async () => {
    const sites = (c: Call) => (c.url.endsWith('/v1/sites') ? (c.method === 'GET' ? { status: 200, body: [{ cbid: 'c9', domain: 'www.Dup.example' }] } : { status: 201, body: { cbid: 'NEW' } }) : undefined);
    const h = harness({ respond: sites as never });
    expect(await run(['init', '--domain', 'dup.example', '--out', 'a.json'], h.io)).toBe(0);
    expect(h.calls.some((c) => c.method === 'POST')).toBe(false);
    expect(h.written['a.json']).toMatch(/"cbid": "c9"/);
    const kept = harness({ respond: sites as never, files: { 'a.json': JSON.stringify({ site: { cbid: 'c9' } }) } });
    expect(await run(['init', '--domain', 'dup.example', '--out', 'a.json'], kept.io)).toBe(0);
    expect(kept.written).toEqual({});
    expect(kept.err()).toMatch(/left as it is/);
  });

  it('API errors print the server message, not the bare code', async () => {
    const h = harness({ respond: ((c: Call) => (c.url.includes('/v1/sandbox') ? { status: 403, body: { error: 'insufficient_scope', message: 'missing required scope: orgs:create', code: 'forbidden' } } : undefined)) as never });
    expect(await run(['sandbox', 'create', '--key-name', 'x'], h.io)).toBe(1);
    expect(h.err()).toMatch(/API error 403 \(forbidden\): missing required scope: orgs:create/);
  });
});

describe('the second retest', () => {
  const sites = (c: Call) => (c.url.endsWith('/v1/sites') && c.method === 'GET' ? { status: 200, body: [{ cbid: 'a1', domain: 'a.example' }] } : undefined);

  it('doctor fails on a site that does not exist; a check that could not run still does not', async () => {
    const missing = harness({ respond: (c) => (c.url.includes('nope') ? { status: 404, body: { error: 'site not found' } } : undefined) as never });
    expect(await run(['doctor', '--site', 'nope', '--fix-plan'], missing.io)).toBe(1);
    expect(missing.out()).toContain('no site in this organisation has the cbid "nope"');
    expect(missing.out()).not.toContain('Nothing left to do');
    const down = harness({ respond: (c) => (c.url.includes('health') ? { status: 500, body: { error: 'boom' } } : c.url.endsWith('/v1/me') ? { status: 200, body: { orgId: 'o', keyPrefix: 'p' } } : c.url.endsWith('/v1/keys/self') ? { status: 200, body: { prefix: 'p' } } : c.url.includes('registry.npmjs.org') ? { status: 200, body: { version: pkg.version } } : c.url.includes('/presets') ? { status: 200, body: { presets: [] } } : undefined) as never });
    expect(await run(['doctor', '--site', 'acme'], down.io)).toBe(0);
  });

  it('doctor refuses a flag it would ignore', async () => {
    const h = harness();
    expect(await run(['doctor', '--out', 'x.json'], h.io)).toBe(2);
  });

  it('--fix-plan gives one step per action, naming every site, and drops the org as a subject', async () => {
    const respond = (c: Call) => {
      if (c.url.endsWith('/v1/me')) return { status: 200, body: { orgId: 'o1', unscoped: true, rights: { warningDetails: [
        { message: 'm', fix: 'PUT /v1/org/mail-provider, then POST /v1/org/mail-provider/test.' },
        { message: 'm', fix: 'PUT /v1/org/controller.', cbids: ['a1', 'b1'] },
        { message: 'm', fix: 'PUT /v1/org/controller, or send cbid on every request.' },
      ] } } };
      if (c.url.includes('health')) return { status: 200, body: { ok: false, counts: { error: 1, warning: 0 }, checks: [
        { ok: false, subject: 'o1', fixHint: 'PUT /v1/org/mail-provider, then POST /v1/org/mail-provider/test.' },
        { ok: false, subject: 'a1', fixHint: 'Connect and test a mail provider (PUT /v1/org/mail-provider, POST /v1/org/mail-provider/test), or set those to "manual_review" (PATCH /v1/sites/a1/rights-page).' },
        { ok: false, subject: 'b1', fixHint: 'Connect and test a mail provider (PUT /v1/org/mail-provider, POST /v1/org/mail-provider/test), or set those to "manual_review" (PATCH /v1/sites/b1/rights-page).' },
      ] } };
      return undefined;
    };
    const h = harness({ respond: respond as never });
    await run(['doctor', '--fix-plan', '--json'], h.io);
    const plan = (JSON.parse(h.out()) as { fixPlan: string[] }).fixPlan;
    expect(plan).toHaveLength(2);
    expect(plan[0]).toMatch(/^a1, b1: Connect and test a mail provider .*\/v1\/sites\/\{cbid\}\/rights-page/);
    expect(plan[1]).toBe('a1, b1: PUT /v1/org/controller, or send cbid on every request.');
  });

  it('init stops before creating a site when --out is for another one, and a same-site rerun is a no-op', async () => {
    const file = JSON.stringify({ site: { cbid: 'a1' } });
    const other = harness({ files: { 'a.json': file }, respond: sites as never });
    expect(await run(['init', '--domain', 'c.example', '--out', 'a.json'], other.io)).toBe(1);
    expect(other.err()).toMatch(/a\.json is for site a1, not c\.example/);
    expect(other.calls.some((c) => c.method === 'POST')).toBe(false);
    const same = harness({ files: { 'a.json': file }, respond: sites as never });
    expect(await run(['init', '--domain', 'a.example', '--out', 'a.json'], same.io)).toBe(0);
    expect(same.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('connect --defer prints the warning about a site that does not exist', async () => {
    const h = harness({ env: { K: 'sk_abc' }, respond: ((c: Call) => (c.url.includes('/v1/dsar/executors') && c.method === 'POST' ? { status: 201, body: { id: 'x', system: 't1', warnings: [{ field: 'cbid', reason: 'no site in this organisation has the cbid "typo"' }] } } : c.url.includes('/v1/dsar/executors') ? { status: 200, body: [] } : undefined)) as never });
    expect(await run(['executors', 'connect', 'chatly', '--site', 'typo', '--key-env', 'K', '--defer'], h.io)).toBe(0);
    expect(h.err()).toContain('warning: no site in this organisation has the cbid "typo"');
  });

  it('dsar test --site files for that site', async () => {
    const h = harness({ respond: ((c: Call) => (c.url.endsWith('/v1/dsar') && c.method === 'POST' ? { status: 201, body: { id: 'r1', type: 'access', cbid: 'b1', status: 'received' } } : undefined)) as never });
    await run(['dsar', 'test', '--site', 'b1'], h.io);
    const posts = h.calls.filter((c) => c.url.endsWith('/v1/dsar') && c.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(JSON.stringify(posts[0])).toContain('b1');
  });

  it('names a connection after the product in the host, not api or www', () => {
    expect(systemFromUrl('https://api.fd-one.example.com')).toBe('fd-one');
    expect(systemFromUrl('https://www.fd-two.co.uk/x')).toBe('fd-two');
    expect(systemFromUrl('https://api.com')).toBeUndefined();
  });
});

describe('every command refuses a flag it would ignore', () => {
  it('names the command and the flag, exit 2, and calls nothing', async () => {
    for (const argv of [['doctor', '--out', 'x.json'], ['config', 'pull', '--site', 'a', '--defer'], ['executors', 'diff', 'f.json', '--secret-env', 'K'], ['scan', '--site', 'a', '--out', 'x'], ['sandbox', 'delete', '--key-name', 'x'], ['plan', '--secrets-out', 'x']]) {
      const h = harness();
      expect(await run(argv, h.io)).toBe(2);
      expect(h.err()).toMatch(/does not take --/);
      expect(h.calls).toHaveLength(0);
    }
  });

  it('reads no help entry wrongly: a flag right after the command is not a subcommand', () => {
    expect(COMMAND_FLAGS.get('scan')).toContain('wait');
    expect(COMMAND_FLAGS.has('scan --site')).toBe(false);
    expect(flagNotTaken(['scan'], { site: 'a', wait: true, json: true })).toBeUndefined();
  });

  it('--erase-subject needs a yes, and neither subject flag runs with --connection', async () => {
    const h = harness({ env: { S: 'k' } });
    expect(await run(['executors', 'conformance', 'https://a.example', '--secret-env', 'S', '--canary-email', 'canary-0123456789abcdef@canary.cookiemunch.net', '--erase-subject', 't@a.example'], h.io)).toBe(2);
    expect(h.err()).toMatch(/really erases/);
    const c = harness();
    expect(await run(['executors', 'conformance', '--connection', 'e1', '--test-subject', 't@a.example'], c.io)).toBe(2);
  });
});

describe('the third retest', () => {
  it('refuses a stray word, and acts on nothing', async () => {
    for (const argv of [['dsar', 'test', '--site', 'b', '--with-cbid', 'a'], ['plan', 'a.json', 'stray'], ['init', '--domain', 'a.example', 'stray'], ['executors', 'connect', 'referalli', 'stray', '--site', 'a'], ['doctor', 'stray']]) {
      const h = harness();
      expect(await run(argv, h.io)).toBe(2);
      expect(h.err()).toMatch(/does not take "/);
      expect(h.calls).toHaveLength(0);
    }
    expect(strayWord(['sandbox', 'show'])).toBeUndefined();
    expect(strayWord(['plan', 'a.json'])).toBeUndefined();
  });

  it('init stops on a file that is not a site\'s, whatever is in it, and creates nothing', async () => {
    for (const content of ['{"mine":1}', 'not json', '']) {
      const h = harness({ files: { 'keep.json': content }, respond: ((c: Call) => (c.url.endsWith('/v1/sites') && c.method === 'GET' ? { status: 200, body: [] } : undefined)) as never });
      expect(await run(['init', '--domain', 'd.example', '--out', 'keep.json'], h.io)).toBe(1);
      expect(h.calls.some((c) => c.method === 'POST')).toBe(false);
    }
  });

  it('a connect missing orgId names the flag and puts it in the next command', async () => {
    const h = harness({ env: { K: 'sk_abc' }, respond: ((c: Call) => (c.url.includes('/v1/dsar/executors') && c.method === 'POST' ? { status: 400, body: { error: 'orgId required for the forumulate preset', code: 'bad_request', field: 'orgId', acceptedFields: ['orgId'] } } : c.url.includes('/v1/dsar/executors') ? { status: 200, body: [] } : undefined)) as never });
    expect(await run(['executors', 'connect', 'forumulate', '--site', 'a', '--key-env', 'K'], h.io)).toBe(1);
    expect(h.err()).toMatch(/Pass it with --org-id/);
    expect(h.err()).toMatch(/--site a --org-id <your forumulate organisation id> --key-env K/);
  });

  it('doctor names the failing warning and its fix; --fail-on accepts it', async () => {
    const respond = ((c: Call) => {
      if (c.url.endsWith('/v1/me')) return { status: 200, body: { orgId: 'o', keyPrefix: 'p' } };
      if (c.url.endsWith('/v1/keys/self')) return { status: 200, body: { prefix: 'p' } };
      if (c.url.includes('registry.npmjs.org')) return { status: 200, body: { version: pkg.version } };
      if (c.url.includes('/v1/integration-health')) return { status: 200, body: { ok: false, counts: { error: 0, warning: 1, notChecked: 0 }, checks: [{ check: 'cookies.undeclared', ok: false, severity: 'warning', subject: 's', fixHint: 'Declare them.' }] } };
      return undefined;
    }) as never;
    const h = harness({ respond });
    expect(await run(['doctor'], h.io)).toBe(1);
    expect(h.out()).toContain('0 error(s), 1 warning(s): cookies.undeclared. First fix: Declare them.');
    expect(await run(['doctor', '--fail-on', 'error'], harness({ respond }).io)).toBe(0);
    expect(await run(['doctor', '--fail-on', 'nope'], harness({ respond }).io)).toBe(2);
  });
});

describe('flags read as switches', () => {
  const source = readdirSync(new URL('../src/', import.meta.url)).filter((f) => f.endsWith('.ts')).map((f) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')).join('\n');
  it('every flag read as `=== true` is one the parser treats as a switch', () => {
    const read = [...source.matchAll(/(?:flag\('([a-z-]+)'\)|flags\.([a-z]+)|flags\['([a-z-]+)'\]) === true/g)].map((m) => m[1] ?? m[2] ?? m[3]!);
    expect(read.length).toBeGreaterThan(5);
    expect([...new Set(read)].filter((f) => !BOOLEAN_FLAGS.has(f))).toEqual([]);
  });
  it('no switch is read as if it had a value', () => {
    const read = [...source.matchAll(/str\((?:p\.flags|h), '([a-z-]+)'\)/g)].map((m) => m[1]!);
    expect(read.length).toBeGreaterThan(5);
    expect([...new Set(read)].filter((f) => BOOLEAN_FLAGS.has(f))).toEqual([]);
  });
  it('a flag the help shows bare is a switch, and one shown with a value is not', () => {
    const usage = source.slice(source.indexOf('USAGE'), source.indexOf('Every command takes'));
    const bare = [...usage.matchAll(/\[--([a-z-]+)\]/g)].map((m) => m[1]!).filter((f) => !BOOLEAN_FLAGS.has(f));
    const valued = [...usage.matchAll(/--([a-z-]+) <[^>]+>/g)].map((m) => m[1]!).filter((f) => BOOLEAN_FLAGS.has(f));
    expect([...new Set(bare)]).toEqual([]);
    expect([...new Set(valued)]).toEqual([]);
  });
});
