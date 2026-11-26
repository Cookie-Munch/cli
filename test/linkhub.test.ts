/** LinkHub's CLI report (2026-11-25): one first apply with suite categories, --yes, csp --no-hashes, lucida/seolyticize. */
import { describe, it, expect } from 'vitest';
import { run } from '../src/cli.js';
import { mergeManifests } from '../src/csp.js';
import { harness, type Call } from './harness.js';

const file = JSON.stringify({
  site: { cbid: 'acme' },
  config: { categories: { suite: ['referrals'] } },
  cookies: [{ name: 'lh_ref', category: 'referrals', purpose: 'Referral attribution' }, { name: 'lh_sess', category: 'necessary', purpose: 'Sign-in' }],
});
const unknownRef = { status: 400, body: { error: 'cookies[0]: unknown category "referrals" — use necessary, preferences, statistics, marketing', code: 'bad_request' } };
const respond = (c: Call) => {
  if (c.url.includes('/config') && c.url.includes('dryRun')) return { status: 200, body: { dryRun: true, diff: [{ path: 'categories.suite', from: null, to: ['referrals'] }], config: { categories: { suite: ['referrals'] } } } };
  if (c.url.includes('/config') && c.method === 'PATCH') return { status: 200, body: {} };
  if (c.url.includes('/cookies') && c.url.includes('dryRun')) {
    const rows = (c.body as { cookies?: Array<{ name: string; category: string }> } | Array<{ name: string; category: string }>);
    const list = Array.isArray(rows) ? rows : rows.cookies ?? [];
    return list.some((r) => r.category === 'referrals') ? unknownRef : { status: 200, body: { dryRun: true, diff: { added: list.map((r) => ({ name: r.name })), removed: [], changed: [] } } };
  }
  if (c.url.includes('/cookies/apply')) return { status: 200, body: { applied: true, steps: [{ step: 'cookies' }], declared: [], count: 2, diff: { added: [{ name: 'lh_ref' }, { name: 'lh_sess' }], removed: [], changed: [] } } };
  return undefined;
};

describe('CM-L1: a category the same file adds', () => {
  it('plan checks those rows after the config part instead of failing', async () => {
    const h = harness({ files: { 'c.json': file }, respond });
    expect(await run(['plan', 'c.json'], h.io)).toBe(0);
    expect(h.out()).toContain('+ lh_ref (after config)');
    expect(h.out()).toContain('+ lh_sess');
  });

  it('one apply stores the config, then the cookies', async () => {
    const h = harness({ files: { 'c.json': file }, respond });
    expect(await run(['apply', 'c.json', '--yes'], h.io)).toBe(0);
    const writes = h.calls.filter((c) => c.method !== 'GET' && !c.url.includes('dryRun')).map((c) => `${c.method} ${c.url.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*/, '')}`);
    expect(writes).toEqual(['PATCH /v1/sites/acme/config', 'POST /v1/sites/acme/cookies/apply']);
  });

  it('a category the file does not add still fails the plan', async () => {
    const bad = JSON.stringify({ site: { cbid: 'acme' }, cookies: [{ name: 'lh_ref', category: 'referrals', purpose: 'x' }] });
    const h = harness({ files: { 'c.json': bad }, respond });
    expect(await run(['plan', 'c.json'], h.io)).not.toBe(0);
    expect(h.err()).toContain('unknown category "referrals"');
  });
});

describe('CM-L9 and CM-X1', () => {
  it('-y and --yes are accepted on apply', async () => {
    for (const y of ['-y', '--yes']) {
      const h = harness({ files: { 'c.json': JSON.stringify({ site: { cbid: 'acme' } }) } });
      expect(await run(['apply', 'c.json', y], h.io)).toBe(0);
    }
  });

  it('--no-hashes leaves hash sources out; lucida and seolyticize are named vendors', async () => {
    const hash = `'sha256-${'A'.repeat(43)}='`;
    const m = [{ surfaces: { w: { csp: { 'script-src': ['https://x.example'] }, requires: { 'script-src': [hash] } } } }];
    expect(mergeManifests(m).get('script-src')).toContain(hash);
    expect(mergeManifests(m, { hashes: false }).get('script-src')).toEqual(["'self'", 'https://x.example']);
    const seo = { product: 'seolyticize', surfaces: { browser: { csp: { 'script-src': ['https://seolyticize.com'], 'connect-src': ['https://seolyticize.com'] } } } };
    const h = harness({ env: { COOKIEMUNCH_API_KEY: '' }, respond: (c) => (c.url === 'https://seolyticize.com/.well-known/seolyticize-embed.json' ? { status: 200, body: seo } : undefined) });
    expect(await run(['csp', '--merge', 'seolyticize', '--no-hashes'], h.io)).toBe(0);
    expect(h.out()).toContain("script-src 'self' https://seolyticize.com");
  });

  it('a vendor with no manifest says it adds nothing', async () => {
    const h = harness({ env: { COOKIEMUNCH_API_KEY: '' } });
    expect(await run(['csp', '--merge', 'watchtower'], h.io)).toBe(1);
    expect(h.err()).toContain('contributes NOTHING');
  });
});
