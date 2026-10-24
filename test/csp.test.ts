/** `cookiemunch csp --merge`: one CSP from several products' embed manifests (CMU-X11). */
import { describe, it, expect } from 'vitest';
import { run } from '../src/cli.js';
import { KNOWN_MANIFEST_HOSTS, manifestSources, mergeManifests, policyString, renderPolicy } from '../src/csp.js';
import { harness } from './harness.js';

const CM = {
  schema: 'https://cookiemunch.net/schemas/embed-v1.json',
  product: 'cookiemunch',
  updated: '2026-10-23T00:00:00Z',
  surfaces: {
    banner: {
      csp: { 'script-src': ['https://cdn.cookiemunch.net', 'https://api.cookiemunch.net'], 'connect-src': ['https://api.cookiemunch.net'], 'img-src': ['https://cdn.cookiemunch.net'] },
      requires: { 'style-src': ["'unsafe-inline'"], 'img-src': ['data:'] },
    },
  },
};
const VENDOR = {
  schema: 'https://cookiemunch.net/schemas/embed-v1.json',
  product: 'acmechat',
  updated: '2026-10-23T00:00:00Z',
  surfaces: { widget: { csp: { 'script-src': ['https://widget.acmechat.example'], 'connect-src': ['wss://ws.acmechat.example', 'https://{tenant}.acmechat.example'] } } },
};

describe('cookiemunch csp', () => {
  it('merges our manifest with any vendor\'s URL into one header, without an API key', async () => {
    const h = harness({
      env: { COOKIEMUNCH_API_KEY: '' },
      respond: (c) =>
        c.url === 'https://cookiemunch.net/.well-known/cookiemunch-embed.json' ? { status: 200, body: CM }
          : c.url === 'https://acmechat.example/.well-known/forgedeck-embed.json' ? { status: 200, body: VENDOR }
            : undefined,
    });
    expect(await run(['csp', '--merge', 'cookiemunch,https://acmechat.example/.well-known/forgedeck-embed.json'], h.io)).toBe(0);
    const header = h.out().trim();
    expect(header).toBe(
      "default-src 'self'; connect-src 'self' https://api.cookiemunch.net wss://ws.acmechat.example; img-src 'self' data: https://cdn.cookiemunch.net; "
      + "script-src 'self' https://api.cookiemunch.net https://cdn.cookiemunch.net https://widget.acmechat.example; style-src 'self' 'unsafe-inline'",
    );
    // A tenant placeholder is never pasted into a policy: it is named for the user to fill in.
    expect(h.err()).toContain('https://{tenant}.acmechat.example');
  });

  it('falls back to the API host, reports a product that publishes nothing, and still prints the rest (exit 1)', async () => {
    const h = harness({
      respond: (c) => (c.url === 'https://api.cookiemunch.net/.well-known/forgedeck-embed.json' ? { status: 200, body: CM } : undefined),
    });
    expect(await run(['csp', '--merge', 'cookiemunch,atlas'], h.io)).toBe(1);
    // Each product's own name first, on each host; the suite-named path last.
    expect(h.calls.map((c) => c.url)).toEqual([
      'https://cookiemunch.net/.well-known/cookiemunch-embed.json',
      'https://api.cookiemunch.net/.well-known/cookiemunch-embed.json',
      'https://cookiemunch.net/.well-known/forgedeck-embed.json',
      'https://api.cookiemunch.net/.well-known/forgedeck-embed.json',
      'https://atlasauth.net/.well-known/atlas-embed.json',
      'https://api.atlasauth.net/.well-known/atlas-embed.json',
      'https://atlasauth.net/.well-known/forgedeck-embed.json',
      'https://api.atlasauth.net/.well-known/forgedeck-embed.json',
    ]);
    expect(h.out()).toContain('https://cdn.cookiemunch.net');
    expect(h.err()).toContain('atlas: no manifest');
  });

  it('refuses a manifest that speaks for another product than the host map expects', async () => {
    const h = harness({ respond: (c) => (c.url.startsWith('https://chatlychat.com/') ? { status: 200, body: VENDOR } : undefined) });
    expect(await run(['csp', '--merge', 'chatly'], h.io)).toBe(1);
    expect(h.err()).toContain('speaks for "acmechat", not chatly');
  });

  it('--site reads the site\'s own manifest from the API', async () => {
    const h = harness({ respond: (c) => (c.url === 'https://api.test/v1/embed?cbid=acme' ? { status: 200, body: CM } : undefined) });
    expect(await run(['csp', '--merge', 'cookiemunch', '--site', 'acme'], h.io)).toBe(0);
    expect(h.calls.map((c) => c.url)).toEqual(['https://api.test/v1/embed?cbid=acme']);
  });

  it('--framework next|express|nginx', async () => {
    const policy = mergeManifests([CM]);
    const value = policyString(policy);
    expect(renderPolicy(policy, 'next')).toContain(`headers: [{ key: 'Content-Security-Policy', value: ${JSON.stringify(value)} }]`);
    expect(renderPolicy(policy, 'express')).toBe(`app.use((req, res, next) => { res.setHeader('Content-Security-Policy', ${JSON.stringify(value)}); next(); });`);
    expect(renderPolicy(policy, 'nginx')).toBe(`add_header Content-Security-Policy "${value}" always;`);
    const h = harness();
    expect(await run(['csp', '--merge', 'cookiemunch', '--framework', 'apache'], h.io)).toBe(2);
  });

  it('a name it does not know is a usage error; the old referally name still works', async () => {
    const h = harness();
    expect(await run(['csp', '--merge', 'nobody'], h.io)).toBe(2);
    expect(manifestSources('referally', { apiBase: 'https://api.test' }).sources[0]!.product).toBe('referalli');
    expect(Object.keys(KNOWN_MANIFEST_HOSTS)).toEqual(['cookiemunch', 'atlas', 'chatly', 'forumulate', 'referalli']);
  });
});

describe('cookiemunch cookies: manifests and suggestions (CMU-X36, CMU-D15)', () => {
  it('import-manifest by URL (dry run), suggestions, declare-suggestions, unpreset of a custom product', async () => {
    const h = harness({
      respond: (c) =>
        c.url.startsWith('https://api.test/v1/sites/acme/cookies/presets/custom') ? { status: 200, body: { vendor: 'acmechat', cookies: [], removed: [], manifest: { status: 'live' } } }
          : c.url === 'https://api.test/v1/sites/acme/cookies/suggestions' ? { status: 200, body: { suggestions: [], vendors: [] } }
            : c.url.startsWith('https://api.test/v1/sites/acme/cookies/suggestions/declare') ? { status: 200, body: { presetsApplied: ['referalli'], declaredCount: 2 } }
              : c.url.startsWith('https://api.test/v1/sites/acme/cookies/presets/acmechat') ? { status: 200, body: { vendor: 'acmechat', removed: ['x'] } }
                : undefined,
    });
    expect(await run(['cookies', 'import-manifest', 'https://acme.example/.well-known/forgedeck-embed.json', '--site', 'acme', '--dry-run'], h.io)).toBe(0);
    expect(h.calls[0]).toMatchObject({ method: 'PUT', url: 'https://api.test/v1/sites/acme/cookies/presets/custom?dryRun=1', body: { url: 'https://acme.example/.well-known/forgedeck-embed.json' } });
    expect(await run(['cookies', 'suggestions', '--site', 'acme'], h.io)).toBe(0);
    expect(await run(['cookies', 'declare-suggestions', '--site', 'acme', '--names', '_ga,referalli_ctx'], h.io)).toBe(0);
    expect(h.calls[2]).toMatchObject({ method: 'POST', body: { names: ['_ga', 'referalli_ctx'] } });
    expect(h.err()).toContain('Declared 2 rows and 1 preset');
    expect(await run(['cookies', 'unpreset', 'acmechat', '--site', 'acme'], h.io)).toBe(0);
    expect(h.calls[3]).toMatchObject({ method: 'DELETE', url: 'https://api.test/v1/sites/acme/cookies/presets/acmechat' });
  });
});
