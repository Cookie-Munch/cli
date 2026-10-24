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
 * Exit codes everywhere: 0 ok (or no changes), 1 a difference, a failure or a failed check, 2 a usage mistake.
 */

import type { CookieMunchClient, DsarExecutor } from '@cookiemunch/sdk';
import type { CliIo } from './cli.js';
import { diffJson, formatChanges, type Change, type Json } from './diff.js';

export interface OpsHelpers {
  requireSite(): string;
  site(): string | undefined;
  readJson(path: string | undefined): Promise<Record<string, unknown>>;
  usage(msg: string): Error;
  flag(name: string): string | true | undefined;
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
const EXECUTOR_FIELDS = ['system', 'baseUrl', 'profile', 'auto', 'subjectNote', 'cbid', 'preset', 'presetVersion', 'presetParams'] as const;
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
    const { id: _i, ...want } = w;
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
      await client.fulfillment.connectExecutor({ ...(body as object), secretKey } as never);
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
  const withCbid = h.flag('with-cbid') === true;
  const without = h.flag('without-cbid') === true || !withCbid;
  const cbid = withCbid ? h.requireSite() : undefined;
  const email = str(h, 'email') ?? 'cookiemunch-cli-test@example.invalid';
  const created: Array<{ id: string; type: string; cbid: string | null; status: string }> = [];
  let failed = false;
  try {
    for (const type of types) {
      for (const scoped of [...(withCbid ? [true] : []), ...(without ? [false] : [])]) {
        const r = await client.dsar.create({ type, subjectEmail: email, regulation: 'gdpr', test: true, ...(scoped ? { cbid } : {}) } as never);
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
  if (json(h)) print(io, { created, deleted });
  else {
    for (const c of created) io.stdout(`${c.id}  ${c.type}${c.cbid ? ` cbid=${c.cbid}` : ' (no cbid)'}  ${c.status}${deleted.includes(c.id) ? '  (deleted)' : ''}\n`);
    io.stderr(`${created.length} test request(s) filed${h.flag('cleanup') === true ? `, ${deleted.length} deleted` : '; delete them with --cleanup or DELETE /v1/dsar/{id}'}.\n`);
  }
  return failed ? 1 : 0;
}

// ---- doctor (CMU-D11) ----

export async function doctorCommand(io: CliIo, client: CookieMunchClient, h: OpsHelpers, cliVersion: string): Promise<number> {
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
  if (site || me) {
    try {
      const r = await client.integrationHealth(site);
      checks.push({ check: 'integration health', ok: r.ok, detail: `${r.counts.error} error(s), ${r.counts.warning} warning(s)` });
    } catch (e) {
      checks.push({ check: 'integration health', ok: null, detail: (e as Error).message });
    }
  }
  if (json(h)) print(io, { ok: checks.every((c) => c.ok !== false), checks });
  else for (const c of checks) io.stdout(`${c.ok === true ? 'ok  ' : c.ok === false ? 'FAIL' : '--  '} ${c.check}: ${c.detail}\n`);
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
  presets?: Array<{ vendor: string; params?: Record<string, unknown> }>;
  executors?: Array<Record<string, Json>>;
  webhooks?: Array<{ url: string; events: string[]; cbid?: string | null }>;
  rightsPage?: Record<string, unknown>;
  partners?: Array<{ partner: string; resource: string; scopes: string[]; externalId?: string; label?: string }>;
}

const PARTS = ['site', 'config', 'cookies', 'presets', 'rightsPage', 'executors', 'webhooks', 'partners'] as const;
type Part = (typeof PARTS)[number];
interface PartPlan { part: Part; changes: number; detail: string[]; apply?: () => Promise<string> }

/**
 * One file for everything a site's privacy setup is (CMU-D12). `plan` asks the server's dry run of every part
 * and prints one combined diff; `apply` applies the parts in dependency order (site → config → cookies →
 * presets → rights page → executors → webhooks → partners), reads each back, and logs when.
 * No secret ever goes in the file: an executor's key comes from --secret-env, a new webhook's secret is
 * written to --secrets-out (0600) or the webhook is not created.
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
    plans.push({ part: 'config', changes: diff.length, detail: diff.map((d) => `${d.path}: ${JSON.stringify(d.from)} → ${JSON.stringify(d.to)}`), apply: async () => { await client.sites.patchConfig(cbid, b.config as never); return 'config patched'; } });
  }
  if (b.cookies) {
    const r = await client.sites.declareCookies(cbid, b.cookies as never, { dryRun: true });
    const d = r.diff ?? { added: [], removed: [], changed: [] };
    plans.push({ part: 'cookies', changes: d.added.length + d.removed.length + d.changed.length, detail: [...d.added.map((c) => `+ ${c.name}`), ...d.removed.map((c) => `- ${c.name}`), ...d.changed.map((c) => `~ ${c.name}`)], apply: async () => { const s = await client.sites.declareCookies(cbid, b.cookies as never); return `${s.saved} declaration(s) saved`; } });
  }
  for (const p of b.presets ?? []) {
    const r = await client.sites.applyCookiePreset(cbid, p.vendor as never, (p.params ?? {}) as never, { dryRun: true });
    const d = (r as { diff?: { added: unknown[]; removed: unknown[]; changed: unknown[] } }).diff;
    const n = d ? d.added.length + d.removed.length + d.changed.length : 0;
    plans.push({ part: 'presets', changes: n, detail: n ? [`${p.vendor}: ${n} declaration change(s)`] : [], apply: async () => { await client.sites.applyCookiePreset(cbid, p.vendor as never, (p.params ?? {}) as never); return `preset ${p.vendor} applied`; } });
  }
  if (b.rightsPage) {
    const r = await client.rightsPage.dryRun(cbid, b.rightsPage, { mode: 'put' });
    const diff = ((r as { diff?: Array<{ path: string }> }).diff ?? []);
    plans.push({ part: 'rightsPage', changes: diff.length, detail: diff.map((d) => d.path), apply: async () => { await client.rightsPage.put(cbid, b.rightsPage as never); return 'rights page draft saved (publish it with cookiemunch rights-page publish)'; } });
  }
  if (b.executors) {
    const current = (await client.fulfillment.executors()).map(executorFileView);
    let n = 0;
    const detail: string[] = [];
    for (const w of b.executors) {
      for (const k of ['secretKey', 'secret', 'webhookSecret']) if (k in w) throw h.usage(`${path}: executors carry no secrets (${k}); use --secret-env`);
      const m = current.find((c) => c.system === w.system);
      const { id: _i, ...want } = w;
      const changes = m ? diffJson(Object.fromEntries(Object.keys(want).map((k) => [k, m[k] ?? null])) as Json, want as Json) : diffJson({}, want as Json);
      if (changes.length) { n++; detail.push(`${m ? 'update' : 'create'} ${String(w.system)}`); }
    }
    plans.push({ part: 'executors', changes: n, detail, apply: async () => { await executorsFileCommand('push', io, client, { ...h, positional: ['executors', 'push', path], readJson: async () => ({ executors: b.executors }) }); return 'executors pushed'; } });
  }
  if (b.webhooks) {
    const have = await client.webhooks.list();
    const missing = b.webhooks.filter((w) => !have.some((x) => x.url === w.url));
    const changed = b.webhooks.filter((w) => { const x = have.find((y) => y.url === w.url); return x && JSON.stringify([...x.events].sort()) !== JSON.stringify([...w.events].sort()); });
    plans.push({
      part: 'webhooks', changes: missing.length + changed.length,
      detail: [...missing.map((w) => `+ ${w.url}`), ...changed.map((w) => `~ ${w.url} events`)],
      apply: async () => {
        const secretsOut = str(h, 'secrets-out');
        if (missing.length && !secretsOut) throw h.usage('creating webhooks shows their signing secrets once: pass --secrets-out <file> (written 0600)');
        const secrets: Record<string, string> = {};
        for (const w of missing) { const s = await client.webhooks.create({ url: w.url, events: w.events, ...(w.cbid !== undefined ? { cbid: w.cbid } : {}) } as never); if (s.secret) secrets[w.url] = s.secret; }
        for (const w of changed) { const x = have.find((y) => y.url === w.url)!; await client.webhooks.update(x.id, { events: w.events } as never); }
        if (secretsOut && Object.keys(secrets).length) await io.writeFile(secretsOut, `${JSON.stringify(secrets, null, 2)}\n`, 0o600);
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
    }
    if (!json(h)) io.stderr(total ? `${total} change(s) in ${plans.filter((p) => p.changes).length} part(s). Apply with: cookiemunch apply ${path}\n` : `No changes: all ${plans.length} part(s) match.\n`);
    return total && h.flag('exit-code') === true ? 1 : 0;
  }
  const log: Array<{ part: Part; at: string; result: string }> = [];
  for (const p of plans) {
    if (!p.changes || !p.apply) continue;
    const result = await p.apply();
    log.push({ part: p.part, at: new Date().toISOString(), result });
    if (!json(h)) io.stderr(`${log[log.length - 1]!.at} ${p.part}: ${result}\n`);
  }
  if (json(h)) print(io, { file: path, cbid, applied: log });
  else if (!log.length) io.stderr('No changes: nothing to apply.\n');
  return 0;
}
