/**
 * CLI completeness (CMU-B15, D11, D12, S02):
 *
 *   cookiemunch --version | version [--json]
 *   cookiemunch cookies diff|push <file> --site <cbid> [--replace]      declarations as a file, through the server's dry run
 *   cookiemunch executors pull|diff|push <file> [--secret-env NAME]     connected systems as a file, never carrying a secret
 *   cookiemunch dsar test --types access,deletion [--with-cbid] [--without-cbid] [--cleanup]
 *   cookiemunch doctor [--site <cbid>] [--org <id>]
 *   cookiemunch keys vend --scopes a,b --ttl 1h [--cbids x,y] [--name n]
 *   cookiemunch keys self | rotate-self
 *   cookiemunch sandbox [show] | create [--key-name n] | delete [--yes]
 *   cookiemunch plan|apply <cookiemunch.json>
 *
 * Exit codes everywhere: 0 ok (or no changes), 1 a difference, a failure or a failed check, 2 a usage mistake,
 * 3 from `plan --exit-code` when the only difference is upstream preset drift.
 */

import { CookieMunchApiError, type CookieMunchClient, type DsarExecutor } from '@cookiemunch/sdk';
import type { CliIo } from './cli.js';
import { diffJson, formatChanges, notKept, type Change, type Json } from './diff.js';

export interface OpsHelpers {
  requireSite(): string;
  site(): string | undefined;
  readJson(path: string | undefined): Promise<Record<string, unknown>>;
  usage(msg: string): Error;
  flag(name: string): string | true | undefined;
  /** Every flag this run was given. */
  flagNames?: string[];
  positional: string[];
}

const json = (h: OpsHelpers) => h.flag('json') === true;
const print = (io: CliIo, v: unknown) => io.stdout(`${JSON.stringify(v, null, 2)}\n`);
const str = (h: OpsHelpers, name: string) => { const v = h.flag(name); return typeof v === 'string' ? v : undefined; };

// ---- version (CMU-B15) ----

/** `version [--json]`: the CLI's version, and with --json the API version the server documents. */
export async function versionCommand(io: CliIo, cliVersion: string, base: string, asJson: boolean): Promise<number> {
  if (!asJson) {
    io.stdout(`${cliVersion}\n`);
    return 0;
  }
  let api: string | null = null;
  try {
    const res = await io.fetch(`${base.replace(/\/+$/, '')}/v1/openapi.json`);
    if (res.ok) api = ((await res.json()) as { info?: { version?: string } }).info?.version ?? null;
  } catch {
    /* unreachable: api stays null */
  }
  print(io, { cli: cliVersion, api });
  return 0;
}

// ---- cookies diff|push <file> (CMU-D11) ----

function cookieRows(file: Record<string, unknown>): Array<Record<string, unknown> & { name: string }> {
  const rows = Array.isArray(file) ? file : Array.isArray(file.cookies) ? file.cookies : null;
  if (!rows || !rows.every((r) => r && typeof r === 'object' && typeof (r as { name?: unknown }).name === 'string')) {
    throw new Error('the file must hold { "cookies": [ { "name", "category", "purpose", … } ] } or that array');
  }
  return rows as Array<Record<string, unknown> & { name: string }>;
}

export async function cookiesFileCommand(sub: 'diff' | 'push', io: CliIo, client: CookieMunchClient, h: OpsHelpers): Promise<number> {
  const cbid = h.requireSite();
  const path = h.positional[2];
  if (!path) throw h.usage(`usage: cookiemunch cookies ${sub} <file> --site <cbid> [--replace]`);
  let rows;
  try { rows = cookieRows(await h.readJson(path)); } catch (e) { throw h.usage((e as Error).message); }
  const replace = h.flag('replace') === true;
  const dry = await client.sites.declareCookies(cbid, rows as never, { replace, dryRun: true });
  const diff = dry.diff ?? { added: [], removed: [], changed: [] };
  const n = diff.added.length + diff.removed.length + diff.changed.length;
  if (json(h)) print(io, { cbid, changes: n, diff, ...(dry.warnings?.length ? { warnings: dry.warnings } : {}) });
  else if (n === 0) io.stderr(`No changes: ${cbid}'s declarations already match.\n`);
  else {
    for (const c of diff.added) io.stdout(`+ ${c.name} (${c.category})\n`);
    for (const c of diff.removed) io.stdout(`- ${c.name}\n`);
    for (const c of diff.changed) io.stdout(`~ ${c.name}: ${formatChanges(diffJson(c.before as unknown as Json, c.after as unknown as Json))}\n`);
  }
  for (const w of dry.warnings ?? []) io.stderr(`warning: ${JSON.stringify(w)}\n`);
  if (sub === 'diff') return n > 0 && h.flag('exit-code') === true ? 1 : 0;
  if (n === 0) return 0;
  const saved = await client.sites.declareCookies(cbid, rows as never, { replace });
  io.stderr(`Applied: ${saved.saved} saved, ${saved.removed} removed.\n`);
  return 0;
}

// ---- executors pull|diff|push <file> (CMU-D11) ----

/** What a file holds for a connection: everything that is not a secret, an id the server assigns, or state. */
const EXECUTOR_FIELDS = ['system', 'baseUrl', 'profile', 'auto', 'subjectNote', 'cbid', 'runAfter', 'preset', 'presetVersion', 'presetParams'] as const;
function executorFileView(e: DsarExecutor): Record<string, Json> {
  const out: Record<string, Json> = { id: e.id };
  for (const k of EXECUTOR_FIELDS) {
    const v = (e as unknown as Record<string, unknown>)[k];
    if (v !== undefined) out[k] = v as Json;
  }
  return out;
}

export async function executorsFileCommand(sub: 'pull' | 'diff' | 'push', io: CliIo, client: CookieMunchClient, h: OpsHelpers): Promise<number> {
  const current = (await client.fulfillment.executors()).map(executorFileView);
  if (sub === 'pull') {
    const text = `${JSON.stringify({ executors: current }, null, 2)}\n`;
    const path = str(h, 'out') ?? h.positional[2];
    if (path) { await io.writeFile(path, text); io.stderr(`Wrote ${current.length} connection(s) to ${path} (no secrets).\n`); } else io.stdout(text);
    return 0;
  }
  const path = h.positional[2];
  if (!path) throw h.usage(`usage: cookiemunch executors ${sub} <file> [--secret-env NAME]`);
  const file = await h.readJson(path);
  const wanted = Array.isArray(file.executors) ? (file.executors as Array<Record<string, Json>>) : null;
  if (!wanted) throw h.usage(`${path} must hold { "executors": [ … ] } (cookiemunch executors pull writes one)`);
  for (const w of wanted) {
    for (const k of ['secretKey', 'secret', 'webhookSecret']) if (k in w) throw h.usage(`${path} carries ${k}: secrets never go in this file; pass --secret-env NAME`);
  }
  const plan: Array<{ system: string; action: 'create' | 'update' | 'unchanged'; id?: string; changes: Change[] }> = [];
  for (const w of wanted) {
    const match = current.find((c) => (w.id && c.id === w.id) || (!w.id && c.system === w.system));
    // `state` says how a new connection starts; it is not something to diff against a live one.
    const { id: _i, state: _s, ...want } = w;
    if (!match) { plan.push({ system: String(w.system), action: 'create', changes: diffJson({}, want as Json) }); continue; }
    const { id, ...have } = match;
    const changes = diffJson(Object.fromEntries(Object.keys(want).map((k) => [k, have[k] ?? null])) as Json, want as Json);
    plan.push({ system: String(w.system), action: changes.length ? 'update' : 'unchanged', id: String(id), changes });
  }
  const pending = plan.filter((p) => p.action !== 'unchanged');
  if (json(h)) print(io, { plan });
  else if (!pending.length) io.stderr('No changes: every connection already matches.\n');
  else for (const p of pending) io.stdout(`${p.action} ${p.system}${p.id ? ` (${p.id})` : ''}\n${formatChanges(p.changes).replace(/^/gm, '  ')}\n`);
  if (sub === 'diff') return pending.length && h.flag('exit-code') === true ? 1 : 0;
  const secretEnv = str(h, 'secret-env');
  // Every create needs its key BEFORE anything is applied: half a push is worse than none.
  const creating = pending.filter((p) => p.action === 'create');
  if (creating.length && !(secretEnv && io.env[secretEnv])) {
    throw h.usage(`creating ${creating.map((p) => p.system).join(', ')} needs its API key: pass --secret-env NAME and export NAME`);
  }
  for (const p of pending) {
    const w = wanted.find((x) => String(x.system) === p.system)!;
    const { id: _i, ...body } = w;
    if (p.action === 'update') {
      await client.fulfillment.updateExecutor(p.id!, Object.fromEntries(p.changes.map((c) => c.path.split(/[.[]/)[0]!).filter((k, i, a) => a.indexOf(k) === i).map((k) => [k, body[k]])) as never);
    } else {
      const secretKey = secretEnv ? io.env[secretEnv] : undefined;
      if (!secretKey) throw h.usage(`creating ${p.system} needs its API key: set --secret-env NAME and export NAME`);
      await client.fulfillment.connectExecutor({ ...(body as object), ...(h.flag('defer') === true ? { state: 'pending' } : {}), secretKey } as never);
    }
  }
  io.stderr(`Applied ${pending.length} change(s).\n`);
  return 0;
}

// ---- dsar test (CMU-D11) ----

/**
 * File test rights requests (guide step 16), read each back, and with --cleanup delete EXACTLY the ids this
 * run created: never a list-and-delete, which once removed live rows (memory never-clean-up-by-listing).
 */
export async function dsarTestCommand(io: CliIo, client: CookieMunchClient, h: OpsHelpers): Promise<number> {
  const types = (str(h, 'types') ?? 'access').split(',').map((t) => t.trim()).filter(Boolean);
  const allowed = ['access', 'deletion', 'rectification', 'portability', 'opt-out'];
  const bad = types.filter((t) => !allowed.includes(t));
  if (bad.length) throw h.usage(`--types takes ${allowed.join(', ')}; not ${bad.join(', ')}`);
  const withCbid = h.flag('with-cbid') === true || (h.flagNames ?? []).includes('site');
  const without = h.flag('without-cbid') === true || !withCbid;
  const cbid = withCbid ? h.requireSite() : undefined;
  const email = str(h, 'email') ?? 'cookiemunch-cli-test@example.invalid';
  const created: Array<{ id: string; type: string; cbid: string | null; status: string }> = [];
  const warnings: unknown[] = [];
  let failed = false;
  try {
    for (const type of types) {
      for (const scoped of [...(withCbid ? [true] : []), ...(without ? [false] : [])]) {
        const r = await client.dsar.create({ type, subjectEmail: email, regulation: 'gdpr', test: true, ...(scoped ? { cbid } : {}) } as never);
        for (const w of (r as { warnings?: Array<{ code?: string; system?: string; connectionCbid?: string }> }).warnings ?? []) {
          warnings.push(w);
          io.stderr(`warning: ${w.code}: ${w.system} is scoped to ${w.connectionCbid}, so this request skips it\n`);
        }
        const back = await client.dsar.get(r.request.id);
        created.push({ id: r.request.id, type, cbid: scoped ? cbid! : null, status: String((back as { status?: string }).status) });
      }
    }
  } catch (e) {
    failed = true;
    io.stderr(`dsar test: ${(e as Error).message}\n`);
  }
  const deleted: string[] = [];
  if (h.flag('cleanup') === true) {
    for (const c of created) {
      try { await client.dsar.delete(c.id); deleted.push(c.id); } catch (e) { failed = true; io.stderr(`could not delete test request ${c.id}: ${(e as Error).message}\n`); }
    }
  }
  if (json(h)) print(io, { created, deleted, ...(warnings.length ? { warnings } : {}) });
  else {
    for (const c of created) io.stdout(`${c.id}  ${c.type}${c.cbid ? ` cbid=${c.cbid}` : ' (no cbid)'}  ${c.status}${deleted.includes(c.id) ? '  (deleted)' : ''}\n`);
    io.stderr(`${created.length} test request(s) filed${h.flag('cleanup') === true ? `, ${deleted.length} deleted` : '; delete them with --cleanup or DELETE /v1/dsar/{id}'}.\n`);
  }
  return failed ? 1 : 0;
}

// ---- doctor (CMU-D11) ----

export async function doctorCommand(io: CliIo, client: CookieMunchClient, h: OpsHelpers, cliVersion: string): Promise<number> {
  const failOn = str(h, 'fail-on') ?? 'warning';
  if (!['error', 'warning', 'never'].includes(failOn)) throw h.usage('--fail-on must be error, warning or never');
  const checks: Array<{ check: string; ok: boolean | null; detail: string }> = [];
  type Me = { orgId?: string; orgName?: string | null; keyPrefix?: string; unscoped?: boolean };
  let me: Me | null = null;
  try {
    me = (await client.me()) as unknown as Me;
    checks.push({ check: 'key', ok: true, detail: `org ${me?.orgName ?? me?.orgId} (${me?.orgId}), key ${me?.keyPrefix}${me?.unscoped ? ', full access' : ''}` });
  } catch (e) {
    checks.push({ check: 'key', ok: false, detail: (e as Error).message });
  }
  const wantOrg = str(h, 'org') ?? io.env.COOKIEMUNCH_ORG;
  if (wantOrg && me?.orgId) checks.push({ check: 'org', ok: me.orgId === wantOrg, detail: me.orgId === wantOrg ? `this key belongs to ${wantOrg}` : `this key's org is ${me.orgId}, not ${wantOrg}, the org your config names` });
  try {
    const self = await client.keys.self();
    const left = typeof self.expiresAt === 'number' ? Math.floor((self.expiresAt - Date.now()) / 86_400_000) : null;
    checks.push({ check: 'key expiry', ok: left === null ? null : left > 7, detail: left === null ? 'no expiry: give automation keys one' : `expires in ${left} day(s)` });
  } catch {
    checks.push({ check: 'key expiry', ok: null, detail: 'this server cannot read the key itself (GET /v1/keys/self)' });
  }
  try {
    const res = await io.fetch('https://registry.npmjs.org/@cookiemunch/cli/latest');
    const latest = res.ok ? ((await res.json()) as { version?: string }).version : undefined;
    checks.push({ check: 'cli version', ok: latest ? latest === cliVersion : null, detail: latest ? (latest === cliVersion ? `${cliVersion}, the latest` : `${cliVersion}; ${latest} is out`) : `${cliVersion}; could not check the latest` });
  } catch {
    checks.push({ check: 'cli version', ok: null, detail: `${cliVersion}; could not check the latest` });
  }
  const site = h.site();
  // A typed site that does not exist is a failure: "could not run" would turn a health check green.
  let noSuchSite = false;
  if (site || me) {
    try {
      const r = await client.integrationHealth(site);
      const failing = (r.checks ?? []).filter((c) => c.ok === false && !c.waived);
      const fails = failOn === 'never' ? false : failOn === 'error' ? r.counts.error > 0 : !r.ok;
      const first = failing.map((c) => c.fix ?? c.fixHint).find(Boolean);
      const named = failing.length ? `: ${[...new Set(failing.map((c) => c.check))].join(', ')}${first ? `. First fix: ${first}` : ''}` : '';
      checks.push({ check: 'integration health', ok: fails ? false : r.ok ? true : null, detail: `${r.counts.error} error(s), ${r.counts.warning} warning(s)${named}` });
    } catch (e) {
      noSuchSite = !!site && e instanceof CookieMunchApiError && e.status === 404;
      checks.push(noSuchSite
        ? { check: 'site', ok: false, detail: `no site in this organisation has the cbid "${site}"` }
        : { check: 'integration health', ok: null, detail: (e as Error).message });
    }
  }
  if (site && !noSuchSite) {
    try {
      // A preset the site writes more than it declares (preset_incomplete): a warning, not a failure.
      for (const p of (await client.sites.cookiePresets(site)).presets) {
        if (p.applied) checks.push({ check: `preset ${p.vendor}`, ok: p.incomplete?.length ? null : true, detail: p.incomplete?.length ? `preset_incomplete: seen but not declared: ${p.incomplete.join(', ')}` : `${p.declared.length} declared` });
      }
    } catch (e) {
      checks.push({ check: 'presets', ok: null, detail: (e as Error).message });
    }
  }
  // --fix-plan: every step still open, in the order to do them.
  // One step per action: the first API path a step names is the action, and it lists everything it fixes.
  const merged = new Map<string, { subjects: string[]; text: string }>();
  const add = (subjects: string[], text: string) => {
    const key = /\/v1\/[^\s,.)]+/.exec(text)?.[0] ?? text;
    const seen = merged.get(key);
    if (!seen) { merged.set(key, { subjects: [...subjects], text }); return; }
    seen.subjects = [...new Set([...seen.subjects, ...subjects])];
    if (text.length > seen.text.length) seen.text = text;
  };
  if (h.flag('fix-plan') === true && !noSuchSite) {
    const account = me as unknown as { unscoped?: boolean; scopes?: string[]; rights?: { warningDetails?: Array<{ message: string; fix: string; requiredScopes?: string[]; cbids?: string[] }> } } | null;
    for (const w of account?.rights?.warningDetails ?? []) {
      if (site && w.cbids && !w.cbids.includes(site)) continue;
      const lacks = w.requiredScopes?.length && !account?.unscoped && !w.requiredScopes.some((x) => account?.scopes?.includes(x));
      add(w.cbids ?? [], `${w.fix}${lacks ? ` (this key lacks ${w.requiredScopes!.join(' or ')})` : ''}`);
    }
    try {
      for (const e of await client.fulfillment.executors()) {
        if (e.state) add([], `Deploy ${e.system}'s rights API, then: cookiemunch executors activate ${e.id}`);
      }
    } catch { /* a key without dsar:read: the health rows below still say what they can */ }
    try {
      const health = await client.integrationHealth(site);
      for (const c of health.checks ?? []) if (c.ok === false && c.fixHint) add(c.subject && c.subject !== me?.orgId ? [c.subject] : [], c.fixHint);
    } catch { /* already reported as a check above */ }
  }
  const steps = [...merged.values()].map(({ subjects, text }) => {
    // Merged across sites, a path naming one of them would read as the only one to change.
    const said = subjects.length > 1 ? text.replace(/\/v1\/sites\/[^/\s,.)]+/g, '/v1/sites/{cbid}') : text;
    return `${subjects.length ? `${subjects.join(', ')}: ` : ''}${said}`;
  });
  if (json(h)) print(io, { ok: checks.every((c) => c.ok !== false), checks, ...(h.flag('fix-plan') === true ? { fixPlan: steps } : {}) });
  else {
    for (const c of checks) io.stdout(`${c.ok === true ? 'ok  ' : c.ok === false ? 'FAIL' : '--  '} ${c.check}: ${c.detail}\n`);
    if (h.flag('fix-plan') === true && !noSuchSite) {
      io.stdout(steps.length ? '\nStill to do, in order:\n' : '\nNothing left to do.\n');
      steps.forEach((s, i) => io.stdout(`${i + 1}. ${s}\n`));
    }
  }
  return checks.some((c) => c.ok === false) ? 1 : 0;
}

// ---- keys vend | self | rotate-self (CMU-S02, D09) ----

/** `1h`, `30m`, `90s`, `3600` → seconds. */
export function parseTtl(v: string): number | null {
  const m = /^(\d+)([smh]?)$/.exec(v.trim());
  if (!m) return null;
  const n = Number(m[1]) * (m[2] === 'h' ? 3600 : m[2] === 'm' ? 60 : 1);
  return n >= 60 && n <= 43200 ? n : null;
}

export async function keysExtraCommand(sub: string, io: CliIo, client: CookieMunchClient, h: OpsHelpers): Promise<number> {
  if (sub === 'self') { print(io, await client.keys.self()); return 0; }
  if (sub === 'rotate-self') {
    const r = await client.keys.rollSelf();
    if (json(h)) print(io, r);
    else { io.stdout(`${r.key ?? r.sealed_secret}\n`); io.stderr('The old key stopped working. This new one is shown once: store it now.\n'); }
    return 0;
  }
  if (sub === 'vend') {
    const scopes = (str(h, 'scopes') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!scopes.length) throw h.usage('--scopes a,b is required (a vended key is never full access)');
    const ttl = parseTtl(str(h, 'ttl') ?? '');
    if (ttl === null) throw h.usage('--ttl is required: 1h, 30m or seconds, from 60 s to 12 h');
    const cbids = str(h, 'cbids')?.split(',').map((s) => s.trim()).filter(Boolean);
    const name = str(h, 'name');
    const r = await client.keys.vend({ scopes, ttlSeconds: ttl, ...(cbids?.length ? { cbids } : {}), ...(name ? { name } : {}) });
    if (json(h)) print(io, r);
    else { io.stdout(`${r.key ?? (r as { sealed_secret?: string }).sealed_secret}\n`); io.stderr(`Valid until ${new Date(r.expiresAt).toISOString()} (${scopes.join(', ')}).\n`); }
    return 0;
  }
  throw h.usage('usage: cookiemunch keys report|vend|self|rotate-self');
}

// ---- sandbox (CMU-F10) ----

/** `sandbox [show]`, `sandbox create [--key-name n]` (prints the test key alone), `sandbox delete [--yes]`. */
export async function sandboxCommand(sub: string | undefined, io: CliIo, client: CookieMunchClient, h: OpsHelpers): Promise<number> {
  if (sub === undefined || sub === 'show') {
    const s = await client.sandbox.get();
    if (json(h) || s) print(io, s);
    else io.stderr('This organisation has no sandbox. Make one with: cookiemunch sandbox create\n');
    return 0;
  }
  if (sub === 'create') {
    const keyName = str(h, 'key-name');
    const r = await client.sandbox.create(keyName ? { keyName } : {});
    if (json(h)) print(io, r);
    else {
      io.stdout(`${r.key}\n`);
      io.stderr(`${r.created ? 'Made' : 'Using'} sandbox ${r.sandbox.orgId} (${r.sandbox.name}). The key above is shown once: store it now.\n`);
    }
    return 0;
  }
  if (sub === 'delete') {
    const s = await client.sandbox.get();
    if (!s) { io.stderr('There is no sandbox.\n'); return 1; }
    if (h.flag('yes') !== true) {
      if (!io.confirm) throw h.usage('sandbox delete erases the sandbox and everything in it, and there is no terminal to confirm in. Pass --yes to delete without a prompt.');
      if (!(await io.confirm(`Erase sandbox ${s.orgId} (${s.name}) and everything in it? This cannot be undone. [y/N] `))) {
        io.stderr('Not deleted.\n');
        return 1;
      }
    }
    const r = await client.sandbox.delete();
    if (json(h)) print(io, r);
    else io.stderr(`Erased sandbox ${r.orgId ?? s.orgId}: ${Object.entries(r.counts).map(([k, v]) => `${v} ${k}`).join(', ')}.\n`);
    return 0;
  }
  throw h.usage('usage: cookiemunch sandbox [show] | create [--key-name <n>] | delete [--yes]');
}

// ---- plan | apply <cookiemunch.json> (CMU-D12) ----

interface Bundle {
  site?: { cbid?: string; domain?: string; name?: string; aliases?: string[] };
  config?: Record<string, unknown>;
  cookies?: Array<Record<string, unknown> & { name: string }>;
  /** `pinned`: this site does not follow the preset; plan reports upstream changes and apply leaves them. */
  presets?: Array<{ vendor: string; params?: Record<string, unknown>; pinned?: boolean }>;
  executors?: Array<Record<string, Json>>;
  /** `secretEnv` names an environment variable holding a signing secret you chose; the file never holds one. */
  webhooks?: Array<{ url: string; events: string[]; cbid?: string | null; secretEnv?: string }>;
  rightsPage?: Record<string, unknown>;
  partners?: Array<{ partner: string; resource: string; scopes: string[]; externalId?: string; label?: string }>;
}

const PARTS = ['site', 'config', 'cookies', 'presets', 'rightsPage', 'executors', 'webhooks', 'partners'] as const;
type Part = (typeof PARTS)[number];
interface PartPlan { part: Part; changes: number; detail: string[]; rows?: string[]; info?: string[]; presets?: Array<{ system: unknown; preset: string; presetVersion?: number; latestVersion?: number; pinned: boolean }>; notApplied?: string[]; apply?: () => Promise<string> }

/**
 * One file for everything a site's privacy setup is (CMU-D12). `plan` asks the server's dry run of every part
 * and prints one combined diff; `apply` applies the parts in dependency order (site → config → cookies →
 * presets → rights page → executors → webhooks → partners), reads each back, and logs when.
 * No secret ever goes in the file: an executor's key comes from --secret-env, a new webhook's secret comes
 * from the variable its `secretEnv` names, or is written to --secrets-out (0600), or the webhook is not created.
 */
export async function bundleCommand(sub: 'plan' | 'apply', io: CliIo, client: CookieMunchClient, h: OpsHelpers): Promise<number> {
  const path = h.positional[1] ?? 'cookiemunch.json';
  const b = (await h.readJson(path)) as unknown as Bundle;
  for (const k of Object.keys(b)) if (!(PARTS as readonly string[]).includes(k) && k !== '$schema') throw h.usage(`${path}: unknown part ${k}; parts are ${PARTS.join(', ')}`);
  const cbid = b.site?.cbid ?? h.site();
  if (!cbid) throw h.usage(`${path} needs site.cbid (or --site)`);
  const plans: PartPlan[] = [];

  if (b.site) {
    const patch = { ...(b.site.domain ? { domain: b.site.domain } : {}), ...(b.site.name !== undefined ? { name: b.site.name } : {}), ...(b.site.aliases ? { aliases: b.site.aliases } : {}) };
    if (Object.keys(patch).length) {
      const r = await client.sites.update(cbid, patch, { dryRun: true });
      plans.push({ part: 'site', changes: r.diff.length, detail: r.diff.map((d) => `${d.field}: ${JSON.stringify(d.before)} → ${JSON.stringify(d.after)}`), apply: async () => { await client.sites.update(cbid, patch); return 'site updated'; } });
    } else plans.push({ part: 'site', changes: 0, detail: [] });
  }
  if (b.config) {
    const r = await client.sites.dryRunConfig(cbid, b.config as never, { mode: 'patch' });
    const diff = r.diff ?? [];
    const dropped = r.config ? notKept(b.config as Record<string, unknown>, r.config) : [];
    plans.push({ part: 'config', changes: diff.length, detail: diff.map((d) => `${d.path}: ${JSON.stringify(d.from)} → ${JSON.stringify(d.to)}`), ...(dropped.length ? { notApplied: dropped } : {}), apply: async () => { await client.sites.patchConfig(cbid, b.config as never); return 'config patched'; } });
  }
  if (b.cookies) {
    const r = await client.sites.declareCookies(cbid, b.cookies as never, { dryRun: true });
    const d = r.diff ?? { added: [], removed: [], changed: [] };
    plans.push({ part: 'cookies', changes: d.added.length + d.removed.length + d.changed.length, detail: [...d.added.map((c) => `+ ${c.name}`), ...d.removed.map((c) => `- ${c.name}`), ...d.changed.map((c) => `~ ${c.name}`)], apply: async () => { const s = await client.sites.declareCookies(cbid, b.cookies as never); return `${s.saved} declaration(s) saved`; } });
  }
  for (const p of b.presets ?? []) {
    const r = await client.sites.applyCookiePreset(cbid, p.vendor as never, (p.params ?? {}) as never, { dryRun: true });
    const d = (r as { diff?: { added: unknown[]; removed: unknown[]; changed: Array<{ name?: string; before?: unknown; after?: unknown }> } }).diff;
    const n = d ? d.added.length + d.removed.length + d.changed.length : 0;
    const up = (r as { upstream?: { applied: string | null; latest: string } }).upstream;
    const moved = up && up.applied !== up.latest ? ` (manifest ${up.applied ?? 'not applied yet'} -> ${up.latest})` : '';
    const rowName = (x: unknown) => (typeof x === 'string' ? x : String((x as { name?: unknown }).name));
    const rows = d ? [
      ...d.added.map((c) => `+ ${p.vendor}: ${rowName(c)}`),
      ...d.removed.map((c) => `- ${p.vendor}: ${rowName(c)}`),
      ...d.changed.map((c) => `~ ${p.vendor}: ${c.name}: ${formatChanges(diffJson(c.before as Json, c.after as Json))}`),
    ] : [];
    // A pinned preset never counts as a change: it is reported, and apply has nothing to do for it.
    if (p.pinned) {
      plans.push({ part: 'presets', changes: 0, detail: [], rows, info: n ? [`preset ${p.vendor}: pinned, ${n} upstream change(s) not followed${moved}`] : [`preset ${p.vendor}: pinned`] });
      continue;
    }
    plans.push({ part: 'presets', changes: n, detail: n ? [`preset ${p.vendor}: ${n} declaration change(s)${moved}`] : [], rows, apply: async () => { await client.sites.applyCookiePreset(cbid, p.vendor as never, (p.params ?? {}) as never); return `preset ${p.vendor} applied`; } });
  }
  if (b.rightsPage) {
    const r = await client.rightsPage.dryRun(cbid, b.rightsPage, { mode: 'put' });
    const diff = ((r as { diff?: Array<{ path: string }> }).diff ?? []);
    plans.push({ part: 'rightsPage', changes: diff.length, detail: diff.map((d) => d.path), apply: async () => { await client.rightsPage.put(cbid, b.rightsPage as never); return 'rights page draft saved (publish it with cookiemunch rights-page publish)'; } });
  }
  if (b.executors) {
    const live = await client.fulfillment.executors();
    const current = live.map(executorFileView);
    let n = 0;
    const detail: string[] = [];
    const rows: string[] = [];
    const info: string[] = [];
    const presets: Array<{ system: unknown; preset: string; presetVersion?: number; latestVersion?: number; pinned: boolean }> = [];
    for (const w of b.executors) {
      for (const k of ['secretKey', 'secret', 'webhookSecret']) if (k in w) throw h.usage(`${path}: executors carry no secrets (${k}); use --secret-env`);
      const m = current.find((c) => c.system === w.system);
      const { id: _i, state: _s, ...want } = w;
      const changes = m ? diffJson(Object.fromEntries(Object.keys(want).map((k) => [k, m[k] ?? null])) as Json, want as Json) : diffJson({}, want as Json);
      if (changes.length) { n++; detail.push(`${m ? 'update' : 'create'} ${String(w.system)}`); rows.push(`${String(w.system)}: ${formatChanges(changes)}`); }
      const e = live.find((x) => x.system === w.system) as unknown as { id: string; preset?: string; presetVersion?: number; presetLatestVersion?: number; presetPinned?: boolean } | undefined;
      if (e?.preset) presets.push({ system: w.system, preset: e.preset, ...(e.presetVersion !== undefined ? { presetVersion: e.presetVersion } : {}), ...(e.presetLatestVersion !== undefined ? { latestVersion: e.presetLatestVersion } : {}), pinned: e.presetPinned === true });
      if (e?.preset && e.presetVersion !== undefined && e.presetLatestVersion !== undefined && e.presetVersion < e.presetLatestVersion) {
        info.push(e.presetPinned
          ? `preset ${e.preset}: pinned at v${e.presetVersion} (presetPinned), not following v${e.presetLatestVersion}`
          : `preset ${e.preset}: v${e.presetVersion} -> v${e.presetLatestVersion} available (cookiemunch executors upgrade-preset ${e.id})`);
      }
    }
    plans.push({ part: 'executors', changes: n, detail, rows, info, presets, apply: async () => { await executorsFileCommand('push', io, client, { ...h, positional: ['executors', 'push', path], readJson: async () => ({ executors: b.executors }) }); return 'executors pushed'; } });
  }
  if (b.webhooks) {
    for (const w of b.webhooks) if ('secret' in w) throw h.usage(`${path}: webhooks carry no secrets; name an environment variable with secretEnv`);
    const have = await client.webhooks.list();
    const missing = b.webhooks.filter((w) => !have.some((x) => x.url === w.url));
    const changed = b.webhooks.filter((w) => { const x = have.find((y) => y.url === w.url); return x && JSON.stringify([...x.events].sort()) !== JSON.stringify([...w.events].sort()); });
    plans.push({
      part: 'webhooks', changes: missing.length + changed.length,
      detail: [...missing.map((w) => `+ ${w.url}`), ...changed.map((w) => `~ ${w.url} events`)],
      apply: async () => {
        const secretsOut = str(h, 'secrets-out');
        for (const w of missing) if (w.secretEnv && !io.env[w.secretEnv]) throw h.usage(`${w.url}: secretEnv ${w.secretEnv} is not set`);
        if (missing.some((w) => !w.secretEnv) && !secretsOut) throw h.usage('creating webhooks shows their signing secrets once: pass --secrets-out <file> (written 0600), or give each a secretEnv');
        // A signing secret is shown once: know it can be saved before asking for one.
        if (secretsOut && missing.some((w) => !w.secretEnv)) {
          try { await io.checkWritable?.(secretsOut); } catch (e) { throw h.usage(`cannot write --secrets-out ${secretsOut}: ${(e as Error).message}. No webhook was created.`); }
        }
        // A retry after a partial run adds to the file: the secrets already in it are not shown again.
        const before = secretsOut ? await io.readFile(secretsOut).catch(() => null) : null;
        let secrets: Record<string, string> = {};
        if (before !== null) {
          let parsed: unknown;
          try { parsed = JSON.parse(before); } catch { /* refused below */ }
          // Only a file of url -> secret is ours to add to: never merge a secret into someone's bundle.
          const ours = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && Object.entries(parsed).every(([k, v]) => /^https?:\/\//.test(k) && typeof v === 'string');
          if (!ours) throw h.usage(`--secrets-out ${secretsOut} exists and is not a secrets file. No webhook was created. Pass another path.`);
          secrets = parsed as Record<string, string>;
        }
        const madeNow: string[] = [];
        const save = async () => {
          if (!secretsOut || madeNow.length === 0) return;
          try {
            await io.writeFile(secretsOut, `${JSON.stringify(secrets, null, 2)}\n`, 0o600);
          } catch (e) {
            throw new Error(`could not write --secrets-out ${secretsOut}: ${(e as Error).message}. Delete these webhooks and apply again, since their secrets are not shown twice: ${madeNow.join(', ')}`);
          }
        };
        try {
          for (const w of missing) {
            const chosen = w.secretEnv ? io.env[w.secretEnv] : undefined;
            const s = await client.webhooks.create({ url: w.url, events: w.events, ...(w.cbid !== undefined ? { cbid: w.cbid } : {}), ...(chosen ? { secret: chosen } : {}) } as never);
            if (s.secret) { secrets[w.url] = s.secret; madeNow.push(w.url); }
          }
          for (const w of changed) { const x = have.find((y) => y.url === w.url)!; await client.webhooks.update(x.id, { events: w.events } as never); }
        } catch (e) {
          // A later call failed: the webhooks made before it still need their secrets saved.
          await save().catch((saveError: Error) => io.stderr(`${saveError.message}\n`));
          throw e;
        }
        await save();
        return `${missing.length} created, ${changed.length} updated`;
      },
    });
  }
  if (b.partners) {
    const have = await client.partnerLinks.list();
    const missing = b.partners.filter((p) => !have.some((l) => l.partner === p.partner && l.resource === p.resource && l.status !== 'revoked'));
    plans.push({ part: 'partners', changes: missing.length, detail: missing.map((p) => `+ ${p.partner} on ${p.resource} (${p.scopes.join(', ')})`), apply: async () => { for (const p of missing) await client.partnerLinks.create(p as never); return `${missing.length} link(s) created`; } });
  }

  const total = plans.reduce((n, p) => n + p.changes, 0);
  if (sub === 'plan') {
    if (json(h)) print(io, { file: path, cbid, changes: total, parts: plans.map(({ apply: _a, ...p }) => p) });
    else for (const p of plans) {
      io.stdout(`${p.part}: ${p.changes ? `${p.changes} change(s)` : 'No changes'}\n`);
      for (const d of p.detail) io.stdout(`  ${d}\n`);
      for (const d of p.info ?? []) io.stdout(`  ${d}\n`);
      if (h.flag('detail') === true) for (const d of p.rows ?? []) io.stdout(`    ${d}\n`);
      for (const d of p.notApplied ?? []) io.stdout(`  not applied: ${d} (the server's dry run does not keep it)\n`);
    }
    const unapplied = plans.reduce((n, p) => n + (p.notApplied?.length ?? 0), 0);
    if (!json(h)) io.stderr(total ? `${total} change(s) in ${plans.filter((p) => p.changes).length} part(s). Apply with: cookiemunch apply ${path}\n` : unapplied ? '' : `No changes: all ${plans.length} part(s) match.\n`);
    if (unapplied && !json(h)) io.stderr(`${unapplied} field(s) in ${path} would not be applied.\n`);
    if (h.flag('exit-code') !== true) return 0;
    const local = plans.filter((p) => p.part !== 'presets').reduce((n, p) => n + p.changes, 0);
    if (local || unapplied) return 1;
    // 3, not the local-drift 1 (and not 2, which is a usage mistake): only upstream presets moved.
    return total ? 3 : 0;
  }
  const log: Array<{ part: Part; at: string; result: string }> = [];
  for (const p of plans) {
    if (!p.changes || !p.apply) continue;
    if (h.flag('presets-only') === true && p.part !== 'presets') continue;
    const result = await p.apply();
    log.push({ part: p.part, at: new Date().toISOString(), result });
    if (!json(h)) io.stderr(`${log[log.length - 1]!.at} ${p.part}: ${result}\n`);
  }
  if (json(h)) print(io, { file: path, cbid, applied: log });
  else if (!log.length) io.stderr('No changes: nothing to apply.\n');
  return 0;
}

// ---- executors connect | activate (one route for partner connections) ----

const errorBody = (e: unknown) => (e instanceof CookieMunchApiError && e.body && typeof e.body === 'object' ? (e.body as Record<string, unknown>) : {});

/** Mints through the partner, or registers --key-env's key. Ends in a connection, or the one human step and what to run after it. */
/** The product's label in a URL's host: `api.acme.example.com` is `acme`, since `api` and `www` name nothing and collide. */
export function systemFromUrl(url: string): string | undefined {
  const labels = (/^https?:\/\/([^/:?#]+)/i.exec(url)?.[1] ?? '').toLowerCase().split('.').slice(0, -1);
  const label = labels.find((l) => l !== 'api' && l !== 'www');
  return label && /^[a-z][a-z0-9-]{0,31}$/.test(label) ? label : undefined;
}

const warningText = (w: unknown) => {
  const o = (w ?? {}) as { field?: string; reason?: string; message?: string };
  return o.reason ?? o.message ?? JSON.stringify(w);
};

export async function executorConnectCommand(io: CliIo, client: CookieMunchClient, h: OpsHelpers): Promise<number> {
  const name = h.positional[2];
  if (!name) throw h.usage('usage: cookiemunch executors connect <chatly|forumulate|referalli|preset> --site <cbid> [--key-env <VAR>] [--external-id <id>] [--org-id <id>] [--base-url <url>] [--system <name>] [--defer | --no-verify] [--dry-run]');
  const defer = h.flag('defer') === true;
  const noVerify = h.flag('no-verify') === true;
  if (defer && noVerify) throw h.usage('--defer or --no-verify, not both');
  const cbid = h.requireSite();
  const keyEnv = str(h, 'key-env');
  const secretKey = keyEnv ? io.env[keyEnv] : undefined;
  if (keyEnv && !secretKey) throw h.usage(`the environment variable ${keyEnv} is empty`);
  const externalId = str(h, 'external-id');
  const orgId = str(h, 'org-id');
  const baseUrl = str(h, 'base-url');
  // cm-standard-v2 is the one preset with no name of its own: name it after the host unless told otherwise.
  const hostLabel = baseUrl && name === 'cm-standard-v2' ? systemFromUrl(baseUrl) : undefined;
  const system = str(h, 'system') ?? hostLabel;
  const body = {
    preset: name, cbid,
    ...(orgId ? { orgId } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(system ? { system } : {}),
    ...(defer ? { state: 'pending' } : {}),
    ...(secretKey ? { secretKey } : { mintFrom: name, ...(externalId ? { externalId } : {}) }),
  };
  const asFlags = (s = system) => `${orgId ? ` --org-id ${orgId}` : ''}${baseUrl ? ` --base-url ${baseUrl}` : ''}${s ? ` --system ${s}` : ''}`;
  const fallback = `cookiemunch executors connect ${name} --site ${cbid}${asFlags()} --key-env ${name.toUpperCase()}_KEY`;
  const scope = `Scoped to ${cbid}: only requests carrying cbid ${cbid} reach it. POST /v1/dsar defaults cbid only when the org has one site.`;
  // One connection per system name, so the next step for a second site is a new name, never the same command again.
  const taken = await client.fulfillment.executors().then((all) => all.find((e) => e.system === (system ?? name))).catch(() => undefined);
  if (taken) {
    const on = (taken as { cbid?: string }).cbid;
    const next = on === cbid ? `Check it: cookiemunch executors conformance --connection ${taken.id}` : `Connect this site under its own name: cookiemunch executors connect ${name} --site ${cbid}${asFlags(`${system ?? name}-2`)}${keyEnv ? ` --key-env ${keyEnv}` : ''}`;
    const said = `a connection named ${taken.system} already exists (${taken.id}, ${on ? `site ${on}` : 'the whole organisation'}).`;
    if (json(h)) print(io, { connected: false, code: 'conflict', error: said, existing: { id: taken.id, cbid: on ?? null }, nextCommand: next });
    else io.stderr(`Not connected: ${said}\n${next}\n`);
    return 1;
  }
  try {
    if (h.flag('dry-run') === true) {
      const r = await client.fulfillment.dryRunConnectExecutor(body as never);
      if (json(h)) print(io, r);
      else {
        io.stdout(`Would connect ${name}${secretKey ? ` with the key in ${keyEnv}` : `: ${name} mints the key`}.\n${scope}\n`);
        for (const w of (r as { warnings?: Array<{ field?: string }> }).warnings ?? []) {
          // The API's own advice names its query parameter: here, the check is what connecting without --dry-run does.
          io.stderr(`warning: ${w.field === 'secretKey' ? 'the key was not checked. Run without --dry-run to check it: a key that fails is not stored.' : warningText(w)}\n`);
        }
      }
      return 0;
    }
    // Checked before it is stored: a connection that cannot reach its system fails every rights request quietly.
    const r = await client.fulfillment.connectExecutor(body as never, defer || noVerify ? undefined : { verify: true });
    if (json(h)) { print(io, r); return 0; }
    for (const w of (r as { warnings?: unknown[] }).warnings ?? []) io.stderr(`warning: ${warningText(w)}\n`);
    if (defer) io.stdout(`Registered ${r.system} (${r.id}), not connected yet: awaiting its first probe, so requests do not reach it.\n${scope}\nOnce its API is live: cookiemunch executors activate ${r.id}\n`);
    else {
      io.stdout(`Connected ${r.system} (${r.id}).\n${scope}\n`);
      if (noVerify) io.stderr(`warning: the key was not checked (--no-verify). Check it: cookiemunch executors recheck ${r.id}\n`);
      else if (r.verify?.verdict) io.stdout(`Checked: ${r.verify.verdict}\n`);
    }
    if (r.completionSecret) io.stdout(`completionSecret: ${r.completionSecret} (shown once: store it)\n`);
    if (!defer) io.stderr(`Check it: cookiemunch executors conformance --connection ${r.id}\n`);
    return 0;
  } catch (e) {
    if (!(e instanceof CookieMunchApiError) || ![400, 403, 404, 409, 422, 424, 502].includes(e.status)) throw e;
    const b = errorBody(e);
    const needsOrg = b.field === 'orgId' && !orgId;
    const next = needsOrg ? `cookiemunch executors connect ${name} --site ${cbid} --org-id <your ${name} organisation id>${asFlags()} --key-env ${keyEnv ?? `${name.toUpperCase()}_KEY`}` : fallback;
    if (json(h)) { print(io, { connected: false, status: e.status, code: e.code, error: e.message, ...b, ...(e.status === 422 ? {} : { nextCommand: next }) }); return 1; }
    io.stderr(`Not connected${e.code ? ` (${e.code})` : ''}: ${e.message}\n`);
    if (e.status === 422 && baseUrl && /not found/i.test(e.message)) io.stderr('FIX: a rights API built on createRightsHandlers answers a wrong secret with 404, so check the secret first, then the base URL.\n');
    if (e.status === 422) { io.stderr('If its API is not deployed yet, use --defer. To store it unchecked, use --no-verify.\n'); return 1; }
    if (b.field === 'baseUrl' && !baseUrl) { io.stderr('Pass it with --base-url <https url>.\n'); return 1; }
    if (needsOrg) { io.stderr(`Pass it with --org-id.\nThen run: ${next}\n`); return 1; }
    if (b.acceptedFields && e.status === 400 && secretKey) return 1;
    if (typeof b.humanStep === 'string') io.stderr(`Do this: ${b.humanStep}\n`);
    if (!secretKey && e.status !== 404) io.stderr(`Then run: ${fallback}\n`);
    return 1;
  }
}

export async function executorActivateCommand(io: CliIo, client: CookieMunchClient, h: OpsHelpers): Promise<number> {
  const id = h.positional[2];
  if (!id) throw h.usage('usage: cookiemunch executors activate <id>');
  try {
    await client.fulfillment.updateExecutor(id, { state: 'active' } as never);
    io.stdout(`${id} is active.\n`);
    return 0;
  } catch (e) {
    if (!(e instanceof CookieMunchApiError) || e.status !== 422) throw e;
    io.stderr(`Still pending: ${e.message}\n`);
    const rules = (errorBody(e).conformance as { rules?: Array<{ id: string; status: string; detail?: string }> } | undefined)?.rules ?? [];
    for (const r of rules) if (r.status === 'fail') io.stderr(`  FAIL ${r.id}${r.detail ? `: ${r.detail}` : ''}\n`);
    return 1;
  }
}

// ---- init (one file and the lines to add) ----

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export async function initCommand(io: CliIo, client: CookieMunchClient, h: OpsHelpers): Promise<number> {
  const out = str(h, 'out') ?? 'cookiemunch.json';
  const domain = str(h, 'domain');
  const given = h.site();
  if (!given && !domain) throw h.usage('usage: cookiemunch init (--site <cbid> | --domain <d>) [--framework next] [--out cookiemunch.json] [--dry-run]');
  if (domain && !HOSTNAME.test(domain)) throw h.usage('--domain must be a hostname, such as example.com');
  let framework = str(h, 'framework');
  if (!framework) {
    try {
      const pkg = JSON.parse(await io.readFile('package.json')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      if (pkg.dependencies?.next || pkg.devDependencies?.next) framework = 'next';
    } catch { /* no package.json: the plain tag */ }
  }
  const dry = h.flag('dry-run') === true;
  // A re-run, or a CI retry, finds the site it made: a second one would split consent across two cbids.
  const bare = (d: string) => d.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  // Only a web site is this web domain's site; another platform may hold the same name. An alias is the site too.
  const existing = given ? undefined : (await client.sites.list()).find((s) => ((s as { platform?: string }).platform ?? 'web') === 'web' && [s.domain, ...((s as { aliases?: string[] }).aliases ?? [])].some((d) => bare(d) === bare(domain!)));
  const onDisk = await io.readFile(out).catch(() => null);
  let fileCbid: unknown;
  try { fileCbid = onDisk === null ? undefined : (JSON.parse(onDisk) as { site?: { cbid?: unknown } }).site?.cbid; } catch { /* not ours to read: left as it is */ }
  if (onDisk !== null && typeof fileCbid !== 'string') {
    io.stderr(`${out} exists and is not a Cookie Munch file for a site. Nothing was created or changed. Pass another --out, or move that file.\n`);
    return 1;
  }
  // A file for another site would send a later `apply` to the wrong one, so stop before creating anything.
  if (typeof fileCbid === 'string' && fileCbid !== (given ?? existing?.cbid)) {
    io.stderr(`${out} is for site ${fileCbid}, not ${given ?? existing?.cbid ?? domain}. Nothing was created or changed. Pass another --out, or move that file.\n`);
    return 1;
  }
  if (onDisk === null) {
    try {
      await io.checkWritable?.(out);
    } catch (e) {
      io.stderr(`Cannot write ${out}: ${(e as Error).message}. Nothing was created or changed. Pass another --out.\n`);
      return 1;
    }
  }
  if (existing) io.stderr(`${domain} is already site ${existing.cbid}: using it.\n`);
  const cbid = given ?? existing?.cbid ?? (dry ? '<new site>' : (await client.sites.create({ domain: domain! } as never)).cbid);
  const file = `${JSON.stringify({ site: { cbid }, presets: [], cookies: [], executors: [] }, null, 2)}\n`;
  if (onDisk !== null) io.stderr(`${out} already exists: left as it is.\n`);
  else if (dry) io.stderr(`Would write ${out}.\n`);
  else {
    try {
      await io.writeFile(out, file);
    } catch (e) {
      io.stderr(`Site ${cbid} exists, but ${out} could not be written: ${(e as Error).message}. Run this again with another --out: it finds the site.\n`);
      return 1;
    }
    io.stderr(`Wrote ${out}.\n`);
  }
  io.stdout(framework === 'next'
    ? `Add to the root layout, before other scripts (npm i @cookiemunch/next):
  CookieMunchScript and CookieSettingsLink, both from @cookiemunch/next
  <CookieMunchScript cbid="${cbid}" />
  <CookieSettingsLink />  in the footer
Print the Content-Security-Policy for next.config with: cookiemunch csp --framework next
Gate code on consent: hasConsent('statistics'), onConsentChange(fn).
`
    : `Add first in <head>:
  <script src="https://cdn.cookiemunch.net/consent.js" data-cbid="${cbid}"></script>
Add a footer link that calls CookieMunch.showSettings().
Print your Content-Security-Policy rows with: cookiemunch csp
`);
  io.stdout(`Then:
  cookiemunch plan ${out}
  cookiemunch apply ${out}
  cookiemunch doctor --site ${cbid} --fix-plan
`);
  return 0;
}
