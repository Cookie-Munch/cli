/** `cookiemunch cookies …`: vendor presets (CKM-S-29) and removing beacon-written rows (CKM-S-02). */
import { describe, it, expect } from 'vitest';
import { run } from '../src/cli.js';
import { harness } from './harness.js';

describe('cookiemunch cookies', () => {
  it('purge-observed sends the window and reports the count; --dry-run asks for a dry run', async () => {
    const h = harness({ respond: (c) => (c.url.includes('/observed-cookies/purge') ? { status: 200, body: { removed: ['CookieConsent'], count: 1, since: 1 } } : undefined) });
    expect(await run(['cookies', 'purge-observed', '--site', 'dv-1', '--since', '2026-10-19T13:21:40Z', '--dry-run'], h.io)).toBe(0);
    expect(h.calls[0]).toMatchObject({ method: 'POST', url: 'https://api.test/v1/sites/dv-1/observed-cookies/purge?dryRun=1' });
    expect(h.calls[0]!.body).toEqual({ since: '2026-10-19T13:21:40Z' });
    expect(h.err()).toMatch(/Would remove 1 row\./);
  });

  it('purge-observed needs --since', async () => {
    const h = harness({});
    expect(await run(['cookies', 'purge-observed', '--site', 'dv-1'], h.io)).toBe(2);
  });

  it('delete-observed removes one name', async () => {
    const h = harness({ respond: (c) => (c.method === 'DELETE' ? { status: 204 } : undefined) });
    expect(await run(['cookies', 'delete-observed', 'OptanonConsent', '--site', 'dv-1'], h.io)).toBe(0);
    expect(h.calls[0]).toMatchObject({ method: 'DELETE', url: 'https://api.test/v1/sites/dv-1/observed-cookies/OptanonConsent' });
  });

  it('preset takes repeatable --param k=v (booleans parsed) and says when the vendor has no manifest yet', async () => {
    const body = { vendor: 'atlas', cookies: [], removed: [], manifest: { status: 'waiting_on_vendor', waitingOn: 'atlas', item: 'ATL-S-39' } };
    const h = harness({ respond: (c) => (c.method === 'PUT' ? { status: 200, body } : undefined) });
    expect(await run(['cookies', 'preset', 'atlas', '--site', 'dv-1', '--param', 'frontendApiHost=auth.a.com', '--param', 'crossSubdomainCookies=false'], h.io)).toBe(0);
    expect(h.calls[0]).toMatchObject({ method: 'PUT', url: 'https://api.test/v1/sites/dv-1/cookies/presets/atlas' });
    expect(h.calls[0]!.body).toEqual({ frontendApiHost: 'auth.a.com', crossSubdomainCookies: false });
    expect(h.err()).toMatch(/ATL-S-39/);
  });

  it('refuses an unknown vendor', async () => {
    const h = harness({});
    expect(await run(['cookies', 'preset', 'nope', '--site', 'dv-1'], h.io)).toBe(2);
  });

  it('presets and unpreset', async () => {
    const h = harness({ respond: () => ({ status: 200, body: { presets: [], vendor: 'chatly', removed: [] } }) });
    expect(await run(['cookies', 'presets', '--site', 'dv-1'], h.io)).toBe(0);
    expect(await run(['cookies', 'unpreset', 'chatly', '--site', 'dv-1', '--dry-run'], h.io)).toBe(0);
    expect(h.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET https://api.test/v1/sites/dv-1/cookies/presets',
      'DELETE https://api.test/v1/sites/dv-1/cookies/presets/chatly?dryRun=1',
    ]);
  });
});
