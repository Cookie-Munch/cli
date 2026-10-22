/**
 * `cookiemunch site update`, `cookiemunch health`, `cookiemunch provision` and `cookiemunch partners`.
 *
 * Provisioning secrets are read from the environment (COOKIEMUNCH_ATLAS_SECRET_KEY,
 * COOKIEMUNCH_FORUMULATE_TOKEN), never from the command line where they would land in shell history,
 * and are never printed.
 */
import type { CookieMunchClient, PartnerLinkCreate, ProvisionRequest } from '@cookiemunch/sdk';
import type { CliIo } from './cli.js';

interface Helpers {
  requireSite(): string;
  site(): string | undefined;
  readJson(path: string | undefined): Promise<Record<string, unknown>>;
  usage(msg: string): Error;
  flag(name: string): string | true | undefined;
}

const out = (io: CliIo, v: unknown) => io.stdout(`${JSON.stringify(v, null, 2)}\n`);

/** `cookiemunch site update --site <cbid> [--domain d] [--name n | --clear-name] [--aliases a,b] [--dry-run]` */
export async function siteCommand(sub: string | undefined, io: CliIo, client: CookieMunchClient, h: Helpers): Promise<number> {
  if (sub !== 'update') throw h.usage('usage: cookiemunch site update --site <cbid> [--domain <host>] [--name <name>] [--aliases a,b] [--dry-run]');
  const cbid = h.requireSite();
  const domain = h.flag('domain');
  const name = h.flag('name');
  const aliases = h.flag('aliases');
  const patch: { domain?: string; name?: string | null; aliases?: string[] } = {};
  if (typeof domain === 'string') patch.domain = domain;
  if (h.flag('clear-name') === true) patch.name = null;
  else if (typeof name === 'string') patch.name = name;
  if (typeof aliases === 'string') patch.aliases = aliases.split(',').map((a) => a.trim()).filter(Boolean);
  if (Object.keys(patch).length === 0) throw h.usage('nothing to change: give --domain, --name, --clear-name or --aliases');
  const r = await client.sites.update(cbid, patch, { dryRun: h.flag('dry-run') === true });
  out(io, r);
  if (r.effects.verification === 'reset') io.stderr('The domain moved: verify the new domain (GET /v1/sites/{cbid}/verify/challenge).\n');
  for (const w of r.warnings ?? []) io.stderr(`warning (${w.field}): ${w.reason}\n`);
  return 0;
}

/** `cookiemunch health [--site <cbid>]` — exits 1 when a check fails, so CI can gate on it. */
export async function healthCommand(io: CliIo, client: CookieMunchClient, h: Helpers): Promise<number> {
  const r = await client.integrationHealth(h.site());
  if (h.flag('json') === true) out(io, r);
  else {
    for (const c of r.checks) {
      const mark = c.ok === true ? 'ok  ' : c.ok === false ? (c.severity === 'error' ? 'FAIL' : 'WARN') : '--  ';
      io.stdout(`${mark} ${c.check} — ${c.subject}${c.detail ? `: ${c.detail}` : ''}\n`);
      if (c.ok === false && c.fixHint) io.stdout(`     fix: ${c.fixHint}\n`);
    }
    io.stdout(`${r.counts.error} error(s), ${r.counts.warning} warning(s), ${r.counts.notChecked} not checked\n`);
  }
  return r.ok ? 0 : 1;
}

/** `cookiemunch provision <file> [--dry-run]` — the file has no secrets; the environment supplies them. */
export async function provisionCommand(file: string | undefined, io: CliIo, client: CookieMunchClient, h: Helpers): Promise<number> {
  const input = (await h.readJson(file)) as unknown as ProvisionRequest;
  const withSecrets: ProvisionRequest = { ...input };
  if (input.atlas || io.env.COOKIEMUNCH_ATLAS_SECRET_KEY) {
    const secretKey = io.env.COOKIEMUNCH_ATLAS_SECRET_KEY ?? input.atlas?.secretKey;
    if (!secretKey) throw h.usage('set COOKIEMUNCH_ATLAS_SECRET_KEY for the atlas step');
    withSecrets.atlas = { ...(input.atlas ?? {}), secretKey };
  }
  if (input.forumulate) {
    const token = io.env.COOKIEMUNCH_FORUMULATE_TOKEN ?? input.forumulate.token;
    if (!token) throw h.usage('set COOKIEMUNCH_FORUMULATE_TOKEN for the forumulate step');
    withSecrets.forumulate = { ...input.forumulate, token };
  }
  const r = await client.provision(withSecrets, { dryRun: h.flag('dry-run') === true });
  for (const s of r.steps) {
    io.stdout(`${s.status.padEnd(12)} ${s.step}${s.detail ? ` — ${s.detail}` : ''}${s.waitingOn ? ` (waiting on ${s.waitingOn})` : ''}\n`);
  }
  io.stdout(`${r.dryRun ? 'dry run: ' : ''}${r.summary.changed} changed, ${r.summary.unchanged} unchanged, ${r.summary.waiting} waiting, ${r.summary.failed} failed\n`);
  return r.summary.failed ? 1 : 0;
}

/** `cookiemunch partners list|link|unlink --site <cbid> …` */
export async function partnersCommand(sub: string | undefined, rest: string[], io: CliIo, client: CookieMunchClient, h: Helpers): Promise<number> {
  const cbid = h.requireSite();
  if (sub === 'list') { out(io, await client.sites.listPartners(cbid)); return 0; }
  if (sub === 'link') {
    const partner = h.flag('partner');
    const externalId = h.flag('external-id');
    if (partner !== 'forumulate' && partner !== 'atlas') throw h.usage('--partner forumulate|atlas is required');
    if (typeof externalId !== 'string') throw h.usage('--external-id <the partner’s account id> is required');
    const label = h.flag('label');
    const input: PartnerLinkCreate = { partner, externalId, ...(typeof label === 'string' ? { label } : {}) };
    out(io, await client.sites.linkPartner(cbid, input, { dryRun: h.flag('dry-run') === true }));
    return 0;
  }
  if (sub === 'unlink') {
    const id = rest[0];
    if (!id) throw h.usage('usage: cookiemunch partners unlink <linkId> --site <cbid>');
    out(io, await client.sites.unlinkPartner(cbid, id));
    return 0;
  }
  throw h.usage('usage: cookiemunch partners list|link|unlink --site <cbid>');
}

/** `cookiemunch keys report [--unused-days n] [--expiring-days n] [--json]` */
export async function keysCommand(sub: string | undefined, io: CliIo, client: CookieMunchClient, h: Helpers): Promise<number> {
  if (sub !== 'report') throw h.usage('usage: cookiemunch keys report [--unused-days <n>] [--expiring-days <n>] [--json]');
  const n = (name: string): number | undefined => {
    const v = h.flag(name);
    if (v === undefined) return undefined;
    const x = Number(v);
    if (!Number.isInteger(x) || x < 1 || x > 3650) throw h.usage(`--${name} must be whole days from 1 to 3650`);
    return x;
  };
  const unusedDays = n('unused-days');
  const expiringDays = n('expiring-days');
  const r = await client.keys.report({ ...(unusedDays ? { unusedDays } : {}), ...(expiringDays ? { expiringDays } : {}) });
  if (h.flag('json') === true) { out(io, r); return 0; }
  const section = (title: string, rows: Array<{ prefix: string; name?: string | null; reason: string }>) => {
    io.stdout(`${title}: ${rows.length}\n`);
    for (const k of rows) io.stdout(`  ${k.prefix}${k.name ? ` (${k.name})` : ''} — ${k.reason}\n`);
  };
  section(`Unused for ${r.unusedDays}+ days`, r.unused);
  section('Broad access', r.broad);
  section(`Expiring within ${r.expiringDays} days`, r.expiringSoon);
  io.stdout(`${r.total} key(s), ${r.noExpiry} with no expiry\n`);
  return 0;
}
