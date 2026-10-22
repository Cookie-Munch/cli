/** `cookiemunch site update`, `health`, `provision` and `partners`. */
import { describe, it, expect } from 'vitest';
import { run } from '../src/cli.js';
import { harness } from './harness.js';

const UPDATED = { site: { cbid: 'acme', orgId: 'o', domain: 'acme.com', name: 'Acme' }, diff: [{ field: 'domain', before: 'old.acme', after: 'acme.com' }], effects: { verification: 'reset', scanTarget: 'https://acme.com/', previewDefaultUrl: 'https://acme.com', displayName: 'Acme', staleRightsDomains: [] } };

describe('cookiemunch site update', () => {
  it('sends the patch, with --dry-run as ?dryRun=1, and says a move needs re-verifying', async () => {
    const h = harness({ respond: (c) => (c.method === 'PATCH' ? { status: 200, body: UPDATED } : undefined) });
    expect(await run(['site', 'update', '--site', 'acme', '--domain', 'acme.com', '--name', 'Acme', '--aliases', 'www2.acme.com, app.acme.com', '--dry-run'], h.io)).toBe(0);
    expect(h.calls[0]).toMatchObject({ method: 'PATCH', url: 'https://api.test/v1/sites/acme?dryRun=1', body: { domain: 'acme.com', name: 'Acme', aliases: ['www2.acme.com', 'app.acme.com'] } });
    expect(h.err()).toMatch(/verify the new domain/);
  });
  it('--clear-name sends null; nothing to change is a usage error', async () => {
    const h = harness({ respond: (c) => (c.method === 'PATCH' ? { status: 200, body: { ...UPDATED, effects: { ...UPDATED.effects, verification: 'kept' } } } : undefined) });
    expect(await run(['site', 'update', '--site', 'acme', '--clear-name'], h.io)).toBe(0);
    expect(h.calls[0]!.body).toEqual({ name: null });
    expect(await run(['site', 'update', '--site', 'acme'], h.io)).toBe(2);
  });
});

describe('cookiemunch health', () => {
  it('prints each check and exits 1 when one fails', async () => {
    const report = { cbid: 'acme', checkedAt: 1, ok: false, counts: { error: 0, warning: 1, notChecked: 0 }, checks: [
      { check: 'org', ok: true, severity: 'info', subject: 'o', lastCheckedAt: 1 },
      { check: 'mail_provider', ok: false, severity: 'warning', subject: 'o', fixHint: 'PUT /v1/org/mail-provider', lastCheckedAt: 1 },
    ] };
    const h = harness({ respond: (c) => (c.url.startsWith('https://api.test/v1/integration-health') ? { status: 200, body: report } : undefined) });
    expect(await run(['health', '--site', 'acme'], h.io)).toBe(1);
    expect(h.calls[0]!.url).toBe('https://api.test/v1/integration-health?cbid=acme');
    expect(h.out()).toMatch(/WARN mail_provider/);
    expect(h.out()).toMatch(/fix: PUT \/v1\/org\/mail-provider/);
  });
});

describe('cookiemunch provision', () => {
  it('takes secrets from the environment, never prints them', async () => {
    const result = { dryRun: true, product: 'acme', cbid: null, steps: [{ step: 'site', status: 'would_create' }], summary: { changed: 1, unchanged: 0, waiting: 0, failed: 0 } };
    const h = harness({
      env: { COOKIEMUNCH_ATLAS_SECRET_KEY: 'sk_live_SECRET_123', COOKIEMUNCH_FORUMULATE_TOKEN: 'frm_SECRET_456' },
      files: { 'p.json': JSON.stringify({ product: 'acme', domain: 'acme.com', atlas: {}, forumulate: { orgId: 'org_f' } }) },
      respond: (c) => (c.url.startsWith('https://api.test/v1/provision') ? { status: 200, body: result } : undefined),
    });
    expect(await run(['provision', 'p.json', '--dry-run'], h.io)).toBe(0);
    expect(h.calls[0]).toMatchObject({ url: 'https://api.test/v1/provision?dryRun=1', body: { atlas: { secretKey: 'sk_live_SECRET_123' }, forumulate: { token: 'frm_SECRET_456', orgId: 'org_f' } } });
    expect(h.out() + h.err()).not.toMatch(/SECRET/);
  });
});

describe('cookiemunch partners', () => {
  it('links, lists and unlinks', async () => {
    const h = harness({ respond: (c) => (c.url.includes('/partners') ? { status: c.method === 'POST' ? 201 : 200, body: { links: [], change: 'created', link: { id: 'pl1' } } } : undefined) });
    expect(await run(['partners', 'link', '--site', 'acme', '--partner', 'forumulate', '--external-id', 'org_f', '--label', 'docs'], h.io)).toBe(0);
    expect(h.calls[0]).toMatchObject({ method: 'POST', url: 'https://api.test/v1/sites/acme/partners', body: { partner: 'forumulate', externalId: 'org_f', label: 'docs' } });
    expect(await run(['partners', 'list', '--site', 'acme'], h.io)).toBe(0);
    expect(await run(['partners', 'unlink', 'pl1', '--site', 'acme'], h.io)).toBe(0);
    expect(h.calls[2]).toMatchObject({ method: 'DELETE', url: 'https://api.test/v1/sites/acme/partners/pl1' });
  });
});

describe('cookiemunch keys report', () => {
  it('prints each section; COOKIEMUNCH_STRICT_FIELDS=1 sends the strict preference on writes', async () => {
    const report = { generatedAt: 1, unusedDays: 30, expiringDays: 14, unused: [{ prefix: 'fck_aaaa', name: 'old', reason: 'never used; created 40 days ago' }], broad: [], expiringSoon: [], noExpiry: 1, total: 1 };
    const h = harness({ respond: (c) => (c.url.startsWith('https://api.test/v1/keys/report') ? { status: 200, body: report } : undefined) });
    expect(await run(['keys', 'report', '--unused-days', '30'], h.io)).toBe(0);
    expect(h.calls[0]!.url).toBe('https://api.test/v1/keys/report?unusedDays=30');
    expect(h.out()).toMatch(/fck_aaaa \(old\) — never used/);
    expect(await run(['keys', 'report', '--unused-days', '0'], h.io)).toBe(2);
  });
});
