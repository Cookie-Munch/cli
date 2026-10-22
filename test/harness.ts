/** The CLI test harness: a mocked fetch that records every call, and injected file and console I/O. */
import type { CliIo } from '../src/cli.js';

export interface Call {
  method: string;
  url: string;
  body?: unknown;
  auth?: string;
}

export const STORED = {
  cbid: 'acme',
  defaultMode: 'opt-in',
  banner: { layout: 'bar', content: { title: 'Cookies', body: 'We use cookies.' } },
  geoRules: [{ regions: ['eu'], mode: 'opt-in' }],
};

export function harness(opts: { env?: Record<string, string>; files?: Record<string, string>; respond?: (c: Call) => { status: number; body?: unknown } | undefined } = {}) {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const written: Record<string, string> = {};
  const opened: string[] = [];
  const fetchMock = (async (url: string, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(url),
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      auth: (init?.headers as Record<string, string> | undefined)?.Authorization,
    };
    calls.push(call);
    const custom = opts.respond?.(call);
    const r = custom ?? (call.url.endsWith('/v1/sites/acme/config') ? { status: 200, body: call.method === 'GET' ? STORED : { ...STORED, ...(call.body as object) } } : { status: 404, body: { error: 'not found' } });
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  const io: CliIo = {
    env: { COOKIEMUNCH_API_KEY: 'fck_test', COOKIEMUNCH_BASE_URL: 'https://api.test', ...(opts.env ?? {}) },
    fetch: fetchMock,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    readFile: async (p) => {
      const f = opts.files?.[p];
      if (f === undefined) throw new Error('ENOENT');
      return f;
    },
    writeFile: async (p, d) => {
      written[p] = d;
    },
    openUrl: async (u) => {
      opened.push(u);
    },
  };
  return { io, calls, out: () => out.join(''), err: () => err.join(''), written, opened };
}
