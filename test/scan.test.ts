/** `cookiemunch scan`: start a cookie crawl, and with --wait, say how it ended (exit 1 when it failed). */
import { describe, it, expect } from 'vitest';
import { run } from '../src/cli.js';
import { harness } from './harness.js';

const QUEUED = { status: 'scanning', state: 'queued', scanId: 's1', startedAt: 1, lastScannedAt: null };
const DONE = { status: 'idle', state: 'done', scanId: 's1', startedAt: 1, finishedAt: 31_001, durationMs: 31_000, cookieCount: 1, keptFromEarlier: 12, pagesVisited: 5, lastScannedAt: 31_001 };

describe('cookiemunch scan', () => {
  it('starts a scan and prints its state', async () => {
    const h = harness({ respond: (c) => (c.url.endsWith('/v1/sites/acme/scan') && c.method === 'POST' ? { status: 202, body: QUEUED } : undefined) });
    expect(await run(['scan', '--site', 'acme'], h.io)).toBe(0);
    expect(h.calls).toEqual([expect.objectContaining({ method: 'POST', url: 'https://api.test/v1/sites/acme/scan' })]);
    expect(JSON.parse(h.out())).toMatchObject({ scanId: 's1', state: 'queued' });
  });

  it('--wait long-polls until done and summarises it', async () => {
    const h = harness({
      respond: (c) =>
        c.method === 'POST' ? { status: 202, body: QUEUED } : c.url.startsWith('https://api.test/v1/sites/acme/scan?wait=') ? { status: 200, body: DONE } : undefined,
    });
    expect(await run(['scan', '--site', 'acme', '--wait'], h.io)).toBe(0);
    expect(h.calls[1]!.url).toBe('https://api.test/v1/sites/acme/scan?wait=60');
    expect(JSON.parse(h.out())).toMatchObject({ state: 'done', cookieCount: 1 });
    expect(h.err()).toMatch(/done in 31 s: 1 cookie seen on 5 pages, 12 kept from earlier/);
  });

  it('--wait exits 1 with the reason when the scan failed', async () => {
    const failed = { status: 'idle', state: 'failed', scanId: 's1', error: 'timed out after 90 s', lastScannedAt: null };
    const h = harness({ respond: (c) => (c.method === 'POST' ? { status: 202, body: QUEUED } : c.url.includes('/scan?wait=') ? { status: 200, body: failed } : undefined) });
    expect(await run(['scan', '--site', 'acme', '--wait'], h.io)).toBe(1);
    expect(h.err()).toMatch(/failed: timed out after 90 s/);
  });

  it('--timeout bounds the wait; still running at the end is exit 1', async () => {
    const h = harness({ respond: (c) => (c.url.includes('/scan') ? { status: c.method === 'POST' ? 202 : 200, body: QUEUED } : undefined) });
    expect(await run(['scan', '--site', 'acme', '--wait', '--timeout', '1'], h.io)).toBe(1);
    expect(h.calls[1]!.url).toBe('https://api.test/v1/sites/acme/scan?wait=1');
    expect(h.err()).toMatch(/still running/);
  });

  it('a scan already running is waited on with --wait, not an error', async () => {
    const h = harness({
      respond: (c) =>
        c.method === 'POST' ? { status: 409, body: { status: 'already-scanning', scanId: 's0', error: 'already scanning' } } : c.url.includes('/scan?wait=') ? { status: 200, body: DONE } : undefined,
    });
    expect(await run(['scan', '--site', 'acme', '--wait'], h.io)).toBe(0);
    expect(h.err()).toMatch(/already running/);
  });

  it('--timeout must be 1–3600 seconds', async () => {
    const h = harness();
    expect(await run(['scan', '--site', 'acme', '--wait', '--timeout', '0'], h.io)).toBe(2);
  });
});
