import { describe, it, expect } from 'vitest';
import { run } from '../src/cli.js';
import { harness } from './harness.js';

const DRAFT = { v: 1, theme: { preset: 'brand', width: 'normal', density: 'comfortable', colorScheme: 'light' }, sections: [{ id: 'request', type: 'form', props: {} }], form: {}, i18n: { defaultLocale: 'en', autoDetect: true, overrides: {} }, seo: { index: false } };
const routes = (c: { method: string; url: string; body?: unknown }) => {
  if (c.url.endsWith('/v1/sites/acme/rights-page') && c.method === 'GET') return { status: 200, body: { cbid: 'acme', draft: DRAFT, version: 2, updatedAt: 5, warnings: [] } };
  if (c.url.endsWith('/v1/sites/acme/rights-page?dryRun=1')) {
    const b = c.body as { seo?: { favicon?: string } };
    if (b.seo?.favicon === 'http://x') return { status: 422, body: { error: 'invalid_page', issues: [{ path: 'seo.favicon', message: 'must be an https:// URL' }] } };
    return { status: 200, body: { dryRun: true, cbid: 'acme', draft: c.body, warnings: [] } };
  }
  if (c.url.endsWith('/v1/sites/acme/rights-page') && c.method === 'PUT') return { status: 200, body: { cbid: 'acme', draft: c.body, version: 2, warnings: [] } };
  if (c.url.endsWith('/rights-page/publish')) return { status: 200, body: { cbid: 'acme', version: 3, publishedAt: 1 } };
  return undefined;
};

describe('rights-page', () => {
  it('pull writes the draft document', async () => {
    const h = harness({ respond: routes });
    expect(await run(['rights-page', 'pull', '--site', 'acme', '--out', 'rp.json'], h.io)).toBe(0);
    expect(JSON.parse(h.written['rp.json']!)).toEqual(DRAFT);
  });
  it('diff sends only a dry run and lists the changes', async () => {
    const h = harness({ respond: routes, files: { 'rp.json': JSON.stringify({ ...DRAFT, seo: { index: false, title: 'New' } }) } });
    expect(await run(['rights-page', 'diff', '--site', 'acme', 'rp.json', '--exit-code'], h.io)).toBe(1);
    expect(h.out()).toContain('+ seo.title: "New"');
    expect(h.calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET https://api.test/v1/sites/acme/rights-page', 'PUT https://api.test/v1/sites/acme/rights-page?dryRun=1']);
  });
  it('diff and push refuse an invalid file with the server’s issues', async () => {
    const h = harness({ respond: routes, files: { 'rp.json': JSON.stringify({ ...DRAFT, seo: { index: false, favicon: 'http://x' } }) } });
    expect(await run(['rights-page', 'push', '--site', 'acme', 'rp.json'], h.io)).toBe(1);
    expect(h.err()).toContain('seo.favicon: must be an https:// URL');
    expect(h.calls.some((c) => c.method === 'PUT' && !c.url.includes('dryRun'))).toBe(false);
  });
  it('push replaces the draft; publish publishes', async () => {
    const changed = { ...DRAFT, seo: { index: false, title: 'New' } };
    const h = harness({ respond: routes, files: { 'rp.json': JSON.stringify(changed) } });
    expect(await run(['rights-page', 'push', '--site', 'acme', 'rp.json'], h.io)).toBe(0);
    const put = h.calls.find((c) => c.method === 'PUT' && !c.url.includes('dryRun'));
    expect(put?.url).toBe('https://api.test/v1/sites/acme/rights-page');
    // the base it diffed against travels with the write, so a save in between is a conflict, not lost
    expect(put?.body).toEqual({ ...changed, baseUpdatedAt: 5 });
    expect(await run(['rights-page', 'publish', '--site', 'acme', '--yes'], h.io)).toBe(0);
    expect(h.err()).toContain('Published version 3');
    // publish sends the draft it read, so only that draft goes live
    expect(h.calls.find((c) => c.url.endsWith('/publish'))?.body).toEqual({ baseUpdatedAt: 5 });
  });
  it('publish prints why a page cannot go live', async () => {
    const h = harness({ respond: (c) => (c.url.endsWith('/publish') ? { status: 422, body: { error: 'not_publishable', problems: [{ path: 'sections', message: 'The page needs a form section.' }] } } : routes(c)) });
    expect(await run(['rights-page', 'publish', '--site', 'acme', '--yes'], h.io)).toBe(1);
    expect(h.err()).toContain('sections: The page needs a form section.');
  });
  it('an unknown subcommand is a usage error', async () => {
    expect(await run(['rights-page', 'nope', '--site', 'acme'], harness().io)).toBe(2);
  });

  describe('publish confirmation', () => {
    const published = (h: ReturnType<typeof harness>) => h.calls.some((c) => c.url.endsWith('/publish'));
    it('asks first in a terminal and publishes on yes', async () => {
      const h = harness({ respond: routes });
      const asked: string[] = [];
      h.io.confirm = async (q) => { asked.push(q); return true; };
      expect(await run(['rights-page', 'publish', '--site', 'acme'], h.io)).toBe(0);
      expect(asked[0]).toMatch(/Publish acme's rights page draft/);
      expect(published(h)).toBe(true);
    });
    it('does nothing on no', async () => {
      const h = harness({ respond: routes });
      h.io.confirm = async () => false;
      expect(await run(['rights-page', 'publish', '--site', 'acme'], h.io)).toBe(1);
      expect(h.err()).toContain('Not published.');
      expect(published(h)).toBe(false);
    });
    it('refuses without --yes when there is no terminal to ask in', async () => {
      const h = harness({ respond: routes });
      expect(await run(['rights-page', 'publish', '--site', 'acme'], h.io)).toBe(2);
      expect(h.err()).toContain('Pass --yes to publish without a prompt');
      expect(published(h)).toBe(false);
    });
    it('--yes skips the prompt', async () => {
      const h = harness({ respond: routes });
      h.io.confirm = async () => { throw new Error('must not ask'); };
      expect(await run(['rights-page', 'publish', '--site', 'acme', '--yes'], h.io)).toBe(0);
      expect(published(h)).toBe(true);
    });
  });

  describe('draft conflicts', () => {
    const conflict = (c: { method: string; url: string }) =>
      (c.method === 'PUT' && !c.url.includes('dryRun')) || c.url.endsWith('/publish') || c.url.endsWith('/rollback')
        ? { status: 409, body: { error: 'draft_conflict', draft: { cbid: 'acme', draft: DRAFT, version: 2, updatedAt: 9, warnings: [] } } }
        : routes(c as never);
    it('push answers a 409 by saying the draft changed since the diff, exit 1, nothing claimed saved', async () => {
      const h = harness({ respond: conflict, files: { 'rp.json': JSON.stringify({ ...DRAFT, seo: { index: false, title: 'New' } }) } });
      expect(await run(['rights-page', 'push', '--site', 'acme', 'rp.json'], h.io)).toBe(1);
      expect(h.err()).toMatch(/changed since/);
      expect(h.err()).toContain('cookiemunch rights-page diff --site acme rp.json');
      expect(h.err()).not.toContain('Saved the draft');
    });
    it('publish answers a 409 by saying nothing went live, and --yes does not override it', async () => {
      const h = harness({ respond: conflict });
      expect(await run(['rights-page', 'publish', '--site', 'acme', '--yes'], h.io)).toBe(1);
      expect(h.err()).toMatch(/changed since/);
      expect(h.err()).toContain('Nothing was published');
      expect(h.calls.filter((c) => c.url.endsWith('/publish'))).toHaveLength(1);
    });
    it('pull tells you the draft’s updatedAt, and push/publish --base send that instead of a fresh read', async () => {
      const h = harness({ respond: routes, files: { 'rp.json': JSON.stringify({ ...DRAFT, seo: { index: false, title: 'New' } }) } });
      expect(await run(['rights-page', 'pull', '--site', 'acme', '--out', 'rp2.json'], h.io)).toBe(0);
      expect(h.err()).toContain('--base 5');
      expect(await run(['rights-page', 'push', '--site', 'acme', 'rp.json', '--base', '3'], h.io)).toBe(0);
      expect(h.calls.find((c) => c.method === 'PUT' && !c.url.includes('dryRun'))?.body).toMatchObject({ baseUpdatedAt: 3 });
      expect(await run(['rights-page', 'publish', '--site', 'acme', '--yes', '--base', '2026-10-14T00:00:00.000Z'], h.io)).toBe(0);
      expect(h.calls.find((c) => c.url.endsWith('/publish'))?.body).toEqual({ baseUpdatedAt: '2026-10-14T00:00:00.000Z' });
      expect(await run(['rights-page', 'push', '--site', 'acme', 'rp.json', '--base', 'yesterday'], h.io)).toBe(2);
    });
  });
});
