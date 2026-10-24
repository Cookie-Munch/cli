/*
 * A copy of packages/sdk/test/fixtures/reference-executor.ts, so the CLI's tests reach nothing
 * outside the CLI package (it is mirrored to its own public repo). Keep the two in step.
 */
/**
 * A reference cm-standard-v2 executor, as a `fetch` function: what an implementation of the open
 * contract (docs: executor-contract-v2) looks like when it gets every rule right. The conformance
 * kit passes against it; each `violate` flag breaks one rule the way real implementations do, so
 * the kit can be shown to name the rule that fails.
 *
 * Also used by the server's `POST /v1/dsar/executors/{id}/test {conformance: true}` tests.
 */

export interface ReferenceExecutorOptions {
  secret: string;
  canaryEmail: string;
  now?: () => number;
  violate?: {
    /** Erase at once, ignoring executeAfter. */
    deleteImmediately?: boolean;
    /** Fall back to the email when the identity matched no one. */
    emailFallback?: boolean;
    /** Ignore Idempotency-Key. */
    noIdempotency?: boolean;
  };
}

type Subject = { id: string; emails: string[]; identity?: { iss: string; sub: string; ext?: string } };
type Req = { id: string; type: string; canonicalType: string; status: string; subjectId: string; eta?: string; caseId?: string };

const CANONICAL: Record<string, string> = {
  access: 'access', export: 'access', deletion: 'deletion', erase: 'deletion', erasure: 'deletion',
  closure: 'closure', restriction: 'restriction', rectification: 'rectification',
};

export function referenceExecutor(o: ReferenceExecutorOptions): typeof fetch & { subjects: Map<string, Subject>; requests: Map<string, Req> } {
  const now = o.now ?? (() => Date.now());
  const tag = /^canary-([0-9a-f]{16})@/.exec(o.canaryEmail)![1]!;
  const subjects = new Map<string, Subject>([
    ['subj_canary', { id: 'subj_canary', emails: [o.canaryEmail], identity: { iss: 'https://canary.cookiemunch.net', sub: `canary_${tag}`, ext: `canary:${tag}` } }],
  ]);
  const requests = new Map<string, Req>();
  const idem = new Map<string, { fingerprint: string; status: number; body: unknown }>();
  let n = 0;

  const reply = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-version': '2' } });

  const view = (r: Req) => ({ id: r.id, type: r.type, canonicalType: r.canonicalType, status: r.status, ...(r.eta ? { eta: r.eta } : {}) });

  function lookup(body: Record<string, unknown>): Response {
    const identity = (body.identity ?? body.atlas) as { iss?: string; sub?: string; ext?: string } | undefined;
    const emails = Array.isArray(body.emails) ? (body.emails as string[]).map((e) => e.toLowerCase()) : [];
    if (identity?.sub) {
      const bySub = [...subjects.values()].find((s) => s.identity?.iss === identity.iss && s.identity?.sub === identity.sub);
      if (bySub) return reply(200, { subjectId: bySub.id, status: 'found' });
      const byExt = identity.ext ? [...subjects.values()].find((s) => s.identity?.ext === identity.ext) : undefined;
      if (byExt) return reply(200, { subjectId: byExt.id, status: 'found' });
    }
    const byEmail = [...subjects.values()].find((s) => s.emails.some((e) => emails.includes(e)));
    // Never match on email when an identity was given and the email belongs to a different identity.
    if (byEmail && identity?.sub && byEmail.identity && !o.violate?.emailFallback) return reply(200, { subjectId: null, status: 'no_match' });
    if (byEmail) return reply(200, { subjectId: byEmail.id, status: 'found' });
    return reply(200, { subjectId: null, status: 'no_match' });
  }

  function open(body: Record<string, unknown>): Response {
    const canonicalType = typeof body.type === 'string' ? CANONICAL[body.type] : undefined;
    if (!canonicalType) return reply(400, { error: 'unknown type', field: 'type' });
    if (typeof body.subjectId !== 'string' || !subjects.has(body.subjectId)) return reply(400, { error: 'unknown subject', field: 'subjectId' });
    const after = typeof body.executeAfter === 'string' ? Date.parse(body.executeAfter) : NaN;
    if (body.executeAfter !== undefined && Number.isNaN(after)) return reply(400, { error: 'executeAfter must be an ISO date', field: 'executeAfter' });
    const erasing = canonicalType === 'deletion' || canonicalType === 'closure';
    const r: Req = { id: `req_${++n}`, type: String(body.type), canonicalType, subjectId: body.subjectId, status: 'completed', ...(typeof body.caseId === 'string' ? { caseId: body.caseId } : {}) };
    if (erasing && !Number.isNaN(after) && after > now() && !o.violate?.deleteImmediately) {
      r.status = 'scheduled';
      r.eta = new Date(after).toISOString();
    } else if (erasing) {
      subjects.delete(r.subjectId);
    }
    requests.set(r.id, r);
    return reply(201, view(r));
  }

  const handler = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    if (headers.get('authorization') !== `Bearer ${o.secret}`) return reply(401, { error: 'unauthorized' });
    const text = typeof init?.body === 'string' ? init.body : '';
    let body: Record<string, unknown> = {};
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      return reply(400, { error: 'body must be JSON', field: 'body' });
    }
    const path = url.pathname.replace(/^.*\/privacy/, '');
    const key = headers.get('idempotency-key');
    const replayable = method === 'POST' && path === '/requests' && key && !o.violate?.noIdempotency;
    if (replayable) {
      const seen = idem.get(key);
      if (seen) return seen.fingerprint === text ? reply(seen.status, seen.body) : reply(409, { error: 'Idempotency-Key reused with a different body', field: 'Idempotency-Key' });
    }
    let res: Response;
    if (method === 'POST' && path === '/lookup') res = lookup(body);
    else if (method === 'POST' && path === '/requests') res = open(body);
    else {
      const m = /^\/requests\/([^/]+)(\/cancel)?$/.exec(path);
      const r = m ? requests.get(decodeURIComponent(m[1]!)) : undefined;
      if (!m) return reply(404, { error: 'not found' });
      if (!r) return reply(404, { error: 'unknown request' });
      if (m[2] && method === 'POST') {
        if (r.status !== 'scheduled') return reply(409, { error: `cannot cancel a ${r.status} request`, field: 'id' });
        r.status = 'cancelled';
        delete r.eta;
        res = reply(200, view(r));
      } else if (!m[2] && method === 'GET') {
        res = reply(200, view(r));
      } else return reply(405, { error: 'method not allowed' });
    }
    if (replayable) idem.set(key, { fingerprint: text, status: res.status, body: await res.clone().json() });
    return res;
  }) as typeof fetch & { subjects: Map<string, Subject>; requests: Map<string, Req> };
  handler.subjects = subjects;
  handler.requests = requests;
  return handler;
}
