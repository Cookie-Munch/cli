/**
 * Consent-button parity from the terminal: `config validate` lints a file without writing,
 * `config push` prints what the server found, and `--strict` turns warnings into exit 1 for CI
 * (a strict push refuses before it writes anything).
 */
import { describe, it, expect } from 'vitest';
import { run } from '../src/cli.js';
import { harness, type Call } from './harness.js';

const FINDING = {
  code: 'saturation_gap', severity: 'warning', layer: 'banner',
  accept: { label: 'Accept all', element: 'button', background: '#22c55e' },
  reject: { label: 'Reject all', element: 'button', background: '#6b4f2a' },
  metric: { name: 'chroma', value: 0.12, threshold: 0.08 },
  detail: 'Accept is bright and saturated (#22c55e) while Reject is muted (#6b4f2a).',
  fix: 'Use the same colour for both buttons.',
  where: { view: 'bar', theme: 'light' },
};
const NOTICE = { ...FINDING, code: 'confirmshaming', severity: 'notice', detail: 'The Reject label reads as confirmshaming.', fix: 'Use neutral wording.' };
const FILE = JSON.stringify({ banner: { type: 'accept-only' } });

function respond(findings: unknown[]) {
  return (c: Call) => {
    if (c.url.includes('/config/lint')) return { status: 200, body: { mode: 'merged', designWarnings: findings, score: 100 - 20 * findings.length, suggestedReject: [] } };
    if (c.url.endsWith('/v1/sites/acme/config') && c.method !== 'GET') return { status: 200, body: { cbid: 'acme', designWarnings: findings } };
    return undefined;
  };
}
// A real write: PATCH/PUT that is not a dry run. `config push` previews with ?dryRun=1 first (it
// shows the server's own diff), and a dry run stores nothing.
const writes = (calls: Call[]) => calls.filter((c) => (c.method === 'PATCH' || c.method === 'PUT') && !/[?&]dryRun=(1|true)\b/.test(c.url));

describe('config validate', () => {
  it('lints the file on the server, writes nothing, and prints each finding', async () => {
    const h = harness({ files: { 'cm.json': FILE }, respond: respond([FINDING, NOTICE]) });
    expect(await run(['config', 'validate', '--site', 'acme', 'cm.json'], h.io)).toBe(0);
    expect(h.calls.map((c) => [c.method, c.url])).toEqual([['POST', 'https://api.test/v1/sites/acme/config/lint']]);
    expect(h.calls[0]!.body).toEqual({ banner: { type: 'accept-only' } });
    expect(h.out()).toContain('warning  saturation_gap  first layer, view "bar"');
    expect(h.out()).toContain(FINDING.detail);
    expect(h.out()).toContain('fix: Use the same colour for both buttons.');
    expect(h.out()).toContain('notice   confirmshaming');
    expect(h.err()).toMatch(/1 warning, 1 notice/);
    expect(writes(h.calls)).toEqual([]);
  });

  it('--replace lints the file as sent', async () => {
    const h = harness({ files: { 'cm.json': FILE }, respond: respond([]) });
    await run(['config', 'validate', '--site', 'acme', 'cm.json', '--replace'], h.io);
    expect(h.calls[0]!.url).toBe('https://api.test/v1/sites/acme/config/lint?replace=1');
  });

  it('--strict exits 1 on a warning, 0 on notices only', async () => {
    const warned = harness({ files: { 'cm.json': FILE }, respond: respond([FINDING]) });
    expect(await run(['config', 'validate', '--site', 'acme', 'cm.json', '--strict'], warned.io)).toBe(1);
    const noticed = harness({ files: { 'cm.json': FILE }, respond: respond([NOTICE]) });
    expect(await run(['config', 'validate', '--site', 'acme', 'cm.json', '--strict'], noticed.io)).toBe(0);
  });

  it('a fair config says so', async () => {
    const h = harness({ files: { 'cm.json': FILE }, respond: respond([]) });
    expect(await run(['config', 'validate', '--site', 'acme', 'cm.json', '--strict'], h.io)).toBe(0);
    expect(h.err()).toMatch(/No design warnings/);
  });
});

describe('config push', () => {
  it('prints the design warnings the server returned with the save', async () => {
    const h = harness({ files: { 'cm.json': FILE }, respond: respond([FINDING]) });
    expect(await run(['config', 'push', '--site', 'acme', 'cm.json'], h.io)).toBe(0);
    expect(writes(h.calls)).toHaveLength(1);
    expect(h.err()).toContain('warning  saturation_gap');
  });

  it('--strict lints first and refuses to push a config with warnings', async () => {
    const h = harness({ files: { 'cm.json': FILE }, respond: respond([FINDING]) });
    expect(await run(['config', 'push', '--site', 'acme', 'cm.json', '--strict'], h.io)).toBe(1);
    expect(writes(h.calls)).toEqual([]);
    expect(h.err()).toMatch(/not pushed/);
  });

  it('--strict pushes a fair config', async () => {
    const h = harness({ files: { 'cm.json': FILE }, respond: respond([]) });
    expect(await run(['config', 'push', '--site', 'acme', 'cm.json', '--strict'], h.io)).toBe(0);
    expect(writes(h.calls)).toHaveLength(1);
  });
});

describe('summary line (review M4)', () => {
  it('notices alone do not claim Accept is pushed harder', async () => {
    const { summaryLine } = await import('../src/design-warnings.js');
    const line = summaryLine([NOTICE] as never);
    expect(line).toMatch(/0 warnings, 1 notice/);
    expect(line).not.toMatch(/pushed harder|dark pattern/);
    expect(line).toMatch(/worth a look/);
  });
  it('a warning still says what it means', async () => {
    const { summaryLine } = await import('../src/design-warnings.js');
    expect(summaryLine([FINDING, NOTICE] as never)).toMatch(/1 warning, 1 notice — Accept is pushed harder than Reject/);
  });
});
