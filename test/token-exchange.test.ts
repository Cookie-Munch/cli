import { describe, it, expect } from 'vitest';
import { run } from '../src/cli.js';
import { harness } from './harness.js';

/** The exchange posts a form, which the shared harness's JSON fetch can't read: record it here. */
function withExchange(answer: { status: number; body: unknown }, env: Record<string, string> = {}) {
  const h = harness({ env });
  const sent: Array<{ url: string; form: Record<string, string>; auth?: string }> = [];
  h.io.fetch = (async (url: string, init?: RequestInit) => {
    sent.push({
      url: String(url),
      form: Object.fromEntries(new URLSearchParams(String(init?.body ?? ''))),
      auth: (init?.headers as Record<string, string> | undefined)?.Authorization,
    });
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { h, sent };
}

describe('cookiemunch token exchange', () => {
  it('needs no API key, reads the subject token from the named variable, and prints the key alone', async () => {
    const { h, sent } = withExchange(
      { status: 200, body: { access_token: 'cookiemunch_live_org_abc', expires_in: 3600, scope: 'sites:read dsar:read', token_type: 'Bearer' } },
      { STAFF_TOKEN: 'eyJ.subject' },
    );
    delete h.io.env.COOKIEMUNCH_API_KEY;
    const code = await run(['token', 'exchange', '--subject-token-env', 'STAFF_TOKEN', '--scope', 'sites:read,dsar:read', '--resource', 'org:o1', '--expires-in', '900'], h.io);
    expect(code).toBe(0);
    expect(h.out()).toBe('cookiemunch_live_org_abc\n');
    expect(sent[0]!.url).toBe('https://api.test/v1/oauth/token');
    expect(sent[0]!.auth).toBeUndefined();
    expect(sent[0]!.form).toMatchObject({ subject_token: 'eyJ.subject', scope: 'sites:read dsar:read', resource: 'org:o1', expires_in: '900' });
  });

  it('refuses a missing variable, scope or resource (usage, exit 2) and reports a refused exchange (exit 1)', async () => {
    const usage = withExchange({ status: 200, body: {} }, { STAFF_TOKEN: 't' });
    expect(await run(['token', 'exchange', '--subject-token-env', 'NOPE', '--scope', 'sites:read', '--resource', 'org:o1'], usage.h.io)).toBe(2);
    expect(await run(['token', 'exchange', '--subject-token-env', 'STAFF_TOKEN', '--resource', 'org:o1'], usage.h.io)).toBe(2);
    expect(await run(['token', 'exchange', '--subject-token-env', 'STAFF_TOKEN', '--scope', 'sites:read', '--resource', 'o1'], usage.h.io)).toBe(2);
    expect(usage.sent).toEqual([]);
    const refused = withExchange({ status: 400, body: { error: 'invalid_scope', error_description: 'your role (viewer) does not allow: sites:write' } }, { STAFF_TOKEN: 't' });
    expect(await run(['token', 'exchange', '--subject-token-env', 'STAFF_TOKEN', '--scope', 'sites:write', '--resource', 'org:o1'], refused.h.io)).toBe(1);
    expect(refused.h.err()).toContain('invalid_scope');
  });
});
