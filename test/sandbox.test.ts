import { describe, it, expect } from 'vitest';
import { run } from '../src/cli.js';
import { harness } from './harness.js';

const SANDBOX = { orgId: 'sb1', name: 'Acme (sandbox)', sandboxOf: 'o1', createdAt: '2026-10-24T00:00:00.000Z' };

describe('cookiemunch sandbox', () => {
  it('show prints the sandbox; with none it says how to make one', async () => {
    const h = harness({ respond: (c) => (c.url.endsWith('/v1/sandbox') ? { status: 200, body: { sandbox: SANDBOX } } : undefined) });
    expect(await run(['sandbox'], h.io)).toBe(0);
    expect(JSON.parse(h.out())).toEqual(SANDBOX);
    const none = harness({ respond: () => ({ status: 200, body: { sandbox: null } }) });
    expect(await run(['sandbox', 'show'], none.io)).toBe(0);
    expect(none.err()).toContain('sandbox create');
  });

  it('create prints the new test key alone', async () => {
    const h = harness({ respond: (c) => (c.method === 'POST' ? { status: 201, body: { sandbox: SANDBOX, created: true, key: 'cookiemunch_test_org_x', keyPrefix: 'cookiemunch_test_org_x'.slice(0, 22), keyExpiresAt: '2027-10-24T00:00:00.000Z' } } : undefined) });
    expect(await run(['sandbox', 'create', '--key-name', 'ci'], h.io)).toBe(0);
    expect(h.out()).toBe('cookiemunch_test_org_x\n');
    expect(h.calls[0]).toMatchObject({ method: 'POST', body: { keyName: 'ci' } });
  });

  it('delete asks first and refuses with no terminal; --yes erases', async () => {
    const respond = (c: { method: string }) => (c.method === 'DELETE' ? { status: 200, body: { deleted: true, orgId: 'sb1', counts: { sites: 1 } } } : { status: 200, body: { sandbox: SANDBOX } });
    const noTty = harness({ respond });
    expect(await run(['sandbox', 'delete'], noTty.io)).toBe(2);
    expect(noTty.calls.some((c) => c.method === 'DELETE')).toBe(false);
    const declined = harness({ respond });
    declined.io.confirm = async () => false;
    expect(await run(['sandbox', 'delete'], declined.io)).toBe(1);
    expect(declined.calls.some((c) => c.method === 'DELETE')).toBe(false);
    const yes = harness({ respond });
    expect(await run(['sandbox', 'delete', '--yes'], yes.io)).toBe(0);
    expect(yes.calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/v1/sandbox'))).toBe(true);
    expect(yes.err()).toContain('1 sites');
  });
});
