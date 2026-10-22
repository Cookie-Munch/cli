/**
 * `cookiemunch` — the Developer API from a terminal or a CI job.
 *
 *   cookiemunch config pull  --site <cbid> [--out file]
 *   cookiemunch config diff  --site <cbid> <file> [--replace] [--exit-code]
 *   cookiemunch config push  --site <cbid> <file> [--replace] [--strict]
 *   cookiemunch config validate --site <cbid> <file> [--replace] [--strict]
 *   cookiemunch preview      --site <cbid> [--url <url>] [--region eu] [--lang de] [--ttl 900] [--open]
 *   cookiemunch executors test <id> --email <email> [--operation locate]
 *   cookiemunch executors webhook-test <id> --headers-file <json> --body-file <file>
 *   cookiemunch executors deliveries <id>
 *   cookiemunch executors presets
 *   cookiemunch executors upgrade-preset <id> [--preset <name>] [--version <n>] [--org-id <id>] [--atlas-id-app-id <id>] [--dry-run]
 *   cookiemunch rights-page pull|diff|push|publish --site <cbid> [<file>] [--base <updatedAt>] [--yes]
 *   cookiemunch scan         --site <cbid> [--wait] [--timeout <seconds>]
 *   cookiemunch cookies presets|preset|unpreset|delete-observed|purge-observed --site <cbid> …
 *   cookiemunch site update  --site <cbid> [--domain <host>] [--name <name>] [--aliases a,b] [--dry-run]
 *   cookiemunch health       [--site <cbid>] [--json]
 *   cookiemunch provision    <file> [--dry-run]
 *   cookiemunch partners     list|link|unlink --site <cbid> …
 *
 * Everything goes through the typed SDK (@cookiemunch/sdk) except where the SDK has no
 * method yet; those calls go through `rawRequest` with the same key and base URL. All I/O
 * is injected, so the whole CLI is testable with a mocked fetch.
 */

import { createCookieMunch, CookieMunchApiError, type CookieMunchClient } from '@cookiemunch/sdk';
import { diffJson, formatChanges, isPlainObject, mergeLikeServer, withoutReadOnly, type Change, type Json } from './diff.js';
import { rightsPageCommand } from './rights-page.js';
import { healthCommand, keysCommand, partnersCommand, provisionCommand, siteCommand } from './integrations.js';
import { countBySeverity, formatDesignWarnings, summaryLine } from './design-warnings.js';

export const DEFAULT_BASE_URL = 'https://api.cookiemunch.net';

export interface CliIo {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, data: string) => Promise<void>;
  /** Open a URL in the user's browser. */
  openUrl: (url: string) => Promise<void>;
  /**
   * Ask a yes/no question. Present only when a person can answer (an interactive terminal);
   * absent, a command that needs confirmation refuses unless given --yes.
   */
  confirm?: (question: string) => Promise<boolean>;
}

export const USAGE = `cookiemunch — Cookie Munch from the command line

Usage:
  cookiemunch config pull  --site <cbid> [--out <file>]
      Write the site's config as JSON (to stdout, or to <file>).
  cookiemunch config diff  --site <cbid> <file> [--replace] [--exit-code]
      Show what pushing <file> would change (the server's dry run; nothing is stored).
      Read-only fields a pulled file carries (effective, designWarnings, ...) are ignored.
  cookiemunch config push  --site <cbid> <file> [--replace] [--strict]
      Apply <file>. Default: merged over the stored config (PATCH) — fields the file
      leaves out keep their value, and a field set to null is removed (it takes its
      default). --replace sends it whole (PUT): a top-level field the file leaves out
      reverts to its default. Prints any design warnings the server found. --strict
      checks the file first and does not push it (exit 1) when Accept all is pushed
      harder than Reject all anywhere — for CI.
  cookiemunch config validate --site <cbid> <file> [--replace] [--strict]
      Check <file> for consent-button parity on the server, without writing: is Accept
      all more prominent than Reject all (colour, size, placement, copy, custom CSS)?
      Merged over the stored config like push; --replace checks it as sent. --strict
      exits 1 when there is any warning (notices never fail).
  cookiemunch preview --site <cbid> [--url <page>] [--region <eu|de|us-ca…>] [--lang <de…>]
                      [--ttl <seconds>] [--open]
      Print (and with --open, open) a link showing the banner as a visitor in that
      region and language sees it. Works in headless browsers; nothing is recorded.
  cookiemunch executors test <id> (--email <email> | --canary) [--operation <locate|export|erase>]
      Try a connected system against one person without filing a request.
      --operation defaults to locate (lookup is accepted as another name for it).
      --canary uses the organisation's canary address instead: no real person, and
      a canary locate also updates the connection's health. Exits 1 when not ok.
  cookiemunch executors webhook-test <id> --headers-file <json> --body-file <file>
      Would this webhook delivery verify? Sends the headers (a JSON object) and the
      body file byte for byte to the receiver's check; nothing is acted on. Prints
      { verified, stage, reason } and exits 1 when it does not verify.
  cookiemunch executors deliveries <id>
      The last 50 deliveries to that connection's webhook, each with its reason.
  cookiemunch executors presets
      The versioned presets, which are usable now and which wait on another
      platform, and the organisation's canary address.
  cookiemunch executors upgrade-preset <id> [--preset <name>] [--version <n>]
                      [--org-id <id>] [--atlas-id-app-id <id>] [--dry-run]
      Rebuild a connection from its preset's latest version (or --version), keeping
      its id and credentials; --preset adopts one on a hand-written connection.
      Prints the diff; --dry-run changes nothing.
  cookiemunch rights-page pull    --site <cbid> [--out <file>]
      Write the site's rights page draft as JSON, and print its updatedAt for --base.
  cookiemunch rights-page diff    --site <cbid> <file> [--exit-code]
      Validate <file> on the server (dry run) and show what pushing it would change.
  cookiemunch rights-page push    --site <cbid> <file> [--base <updatedAt>]
      Replace the draft with <file>. Nothing is live until publish. Refused (exit 1)
      if the draft changed since the diff, or since --base (the updatedAt pull printed).
  cookiemunch rights-page publish --site <cbid> [--yes] [--base <updatedAt>]
      Publish the draft (it goes live at once). Asks first; --yes skips the question
      and is required when there is no terminal to ask in. Prints why when the page
      cannot go live. Refused (exit 1) if the draft changed after it was read (or
      since --base); --yes never overrides that.

  cookiemunch scan --site <cbid> [--wait] [--timeout <seconds>]
      Start a cookie crawl of the site and print its state (JSON). --wait holds on
      until it is done or failed (default up to 120 s, --timeout to change) and exits
      1 when it failed or is still running at the end. A scan already running is
      waited on rather than started twice.

  cookiemunch cookies presets --site <cbid>
      The declaration presets (atlas, forumulate, chatly, cookiemunch, referally): what each takes,
      what it declared on this site, and whether the vendor's own manifest exists yet.
  cookiemunch cookies preset <vendor> --site <cbid> [--param k=v …] [--dry-run]
      Declare what that platform writes (cookies and browser storage), marked as
      declared by it; run again to re-sync. Atlas: --param frontendApiHost=auth.example.com
      [--param crossSubdomainCookies=false]. Chatly: --param publicId=ch_web_… .
      Referally: [--param cookieDomain=.example.com] [--param cookieDays=60] [--param category=…].
  cookiemunch cookies unpreset <vendor> --site <cbid> [--dry-run]
      Remove every declaration that vendor's preset made.
  cookiemunch cookies delete-observed <name> --site <cbid> [--dry-run]
      Remove every stored row of that name (a name the site never sets). A declaration stays.
  cookiemunch cookies purge-observed --site <cbid> --since <time> [--until <time>] [--dry-run]
      Remove every row a real visit first reported in that window (ISO-8601 or epoch ms).
      Crawled rows and declarations stay. Run with --dry-run first.
  cookiemunch site update --site <cbid> [--domain <host>] [--name <name> | --clear-name]
                          [--aliases <a,b>] [--dry-run]
      Rename or move a site. The cbid and consent ledger stay; a domain move clears
      verification. --dry-run prints the diff and its effects without saving.
  cookiemunch health [--site <cbid>] [--json]
      Every link the site's privacy wiring depends on, with a fix hint for each that
      fails. Exits 1 when a check fails (checks that could not run do not count).
  cookiemunch provision <file> [--dry-run]
      Wire a product's privacy in one call (site, connections, Atlas, Forumulate) from
      a JSON file without secrets: the Atlas key and Forumulate token come from
      COOKIEMUNCH_ATLAS_SECRET_KEY and COOKIEMUNCH_FORUMULATE_TOKEN. Re-running is a
      no-op. Exits 1 when a step failed.
  cookiemunch keys report [--unused-days <n>] [--expiring-days <n>] [--json]
      Key hygiene: keys unused for n days (default 90), keys with broad access, and
      keys expiring within n days (default 14). Needs a full-access key.
  cookiemunch partners list|link|unlink --site <cbid> [--partner forumulate|atlas]
                       [--external-id <id>] [--label <text>] [<linkId>]
      Grant a partner platform the site's consent events (no secret is created), list
      the grants, or revoke one.

Environment:
  COOKIEMUNCH_API_KEY   an API key (fck_…). Required.
  COOKIEMUNCH_BASE_URL  the API origin. Default ${DEFAULT_BASE_URL}.
  COOKIEMUNCH_SITE      default for --site.
  COOKIEMUNCH_STRICT_FIELDS=1  send Prefer: strict-unknown-fields on writes: a field the
                        API does not know is refused (400 unknown_field), not ignored.
`;

/** A usage mistake: exit code 2. */
class UsageError extends Error {}

interface Parsed {
  positional: string[];
  flags: Record<string, string | true>;
}

const BOOLEAN_FLAGS = new Set(['replace', 'exit-code', 'open', 'help', 'json', 'yes', 'strict', 'wait', 'canary', 'dry-run', 'clear-name']);

export function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-h') {
      flags.help = true;
    } else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      let value: string | true;
      if (eq > 0) value = a.slice(eq + 1);
      else if (BOOLEAN_FLAGS.has(name)) value = true;
      else {
        const v = argv[i + 1];
        if (v === undefined || v.startsWith('--')) throw new UsageError(`--${name} needs a value`);
        value = v;
        i++;
      }
      // --param repeats (k=v each); kept newline-joined so the rest of the parser stays simple.
      if (name === 'param' && typeof value === 'string' && typeof flags.param === 'string') flags.param = `${flags.param}\n${value}`;
      else flags[name] = value;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function str(flags: Parsed['flags'], name: string): string | undefined {
  const v = flags[name];
  return typeof v === 'string' ? v : undefined;
}

function requireSite(p: Parsed, io: CliIo): string {
  const site = str(p.flags, 'site') ?? io.env.COOKIEMUNCH_SITE;
  if (!site) throw new UsageError('--site <cbid> is required (or set COOKIEMUNCH_SITE)');
  return site;
}

async function readConfigFile(io: CliIo, path: string | undefined): Promise<Record<string, unknown>> {
  if (!path) throw new UsageError('a config file is required');
  let text: string;
  try {
    text = await io.readFile(path);
  } catch (e) {
    throw new UsageError(`cannot read ${path}: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new UsageError(`${path} is not valid JSON: ${(e as Error).message}`);
  }
  if (!isPlainObject(parsed)) throw new UsageError(`${path} must hold a JSON object`);
  return parsed;
}

/** What the stored config would become, per push mode. */
function proposed(current: Record<string, unknown>, file: Record<string, unknown>, replace: boolean, cbid: string) {
  return replace ? { ...file, cbid } : mergeLikeServer(current, file);
}

/** This package's version, sent in the default User-Agent (a test pins it to package.json). */
export const CLI_VERSION = '0.4.2';

/** `COOKIEMUNCH_USER_AGENT`, else `cookiemunch-cli/<version>`. */
function userAgent(io: CliIo): string {
  return io.env.COOKIEMUNCH_USER_AGENT || `cookiemunch-cli/${CLI_VERSION}`;
}

async function rawRequest(io: CliIo, base: string, key: string, method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await io.fetch(`${base.replace(/\/+$/, '')}/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'User-Agent': userAgent(io), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    /* keep the text */
  }
  if (!res.ok) {
    const err = isPlainObject(data) ? data : {};
    throw new CookieMunchApiError(
      res.status,
      typeof err.error === 'string' ? err.error : `request failed with status ${res.status}`,
      typeof err.code === 'string' ? err.code : undefined,
    );
  }
  return data;
}

/**
 * What a write would change. The server's own `?dryRun=1` diff is the source of truth (it knows
 * its defaults and read-only fields); if it cannot answer, the same is computed here, with the
 * read-only fields (`effective`, `designWarnings`, `rightsFormUrl`, ...) dropped from both sides:
 * a file made by `config pull` carries them, and the server ignores them on a write.
 */
async function configChanges(client: CookieMunchClient, cbid: string, file: Record<string, unknown>, replace: boolean): Promise<Change[]> {
  const body = withoutReadOnly(file);
  try {
    const r = await client.sites.dryRunConfig(cbid, body as never, { mode: replace ? 'put' : 'patch' });
    if (r && r.dryRun === true && Array.isArray(r.diff)) {
      return r.diff.map((c) => {
        const ch: Change = { path: c.path, kind: c.from === undefined ? 'added' : c.to === undefined ? 'removed' : 'changed' };
        if (c.from !== undefined) ch.from = c.from as Json;
        if (c.to !== undefined) ch.to = c.to as Json;
        return ch;
      });
    }
  } catch {
    /* an older or unreachable dry run: fall back to the local diff below */
  }
  const current = withoutReadOnly((await client.sites.getConfig(cbid)) as unknown as Record<string, unknown>);
  return diffJson(current, proposed(current, body, replace, cbid));
}

async function configCommand(sub: string | undefined, p: Parsed, io: CliIo, client: CookieMunchClient): Promise<number> {
  const cbid = requireSite(p, io);
  if (sub === 'pull') {
    const cfg = await client.sites.getConfig(cbid);
    const text = `${JSON.stringify(cfg, null, 2)}\n`;
    const out = str(p.flags, 'out');
    if (out) {
      await io.writeFile(out, text);
      io.stderr(`Wrote ${cbid}'s config to ${out}\n`);
    } else {
      io.stdout(text);
    }
    return 0;
  }
  if (sub === 'validate') {
    const file = await readConfigFile(io, p.positional[2]);
    const r = await client.sites.lintConfig(cbid, file as never, p.flags.replace === true ? { replace: true } : {});
    if (r.designWarnings.length) io.stdout(`${formatDesignWarnings(r.designWarnings)}\n`);
    io.stderr(`${summaryLine(r.designWarnings)}\n`);
    return p.flags.strict === true && countBySeverity(r.designWarnings).warnings > 0 ? 1 : 0;
  }
  if (sub === 'diff' || sub === 'push') {
    const file = await readConfigFile(io, p.positional[2]);
    const replace = p.flags.replace === true;
    // --strict (push): check first, and do not write a config that fails it.
    if (sub === 'push' && p.flags.strict === true) {
      const lint = await client.sites.lintConfig(cbid, file as never, replace ? { replace: true } : {});
      if (countBySeverity(lint.designWarnings).warnings > 0) {
        io.stderr(`${formatDesignWarnings(lint.designWarnings)}\n${summaryLine(lint.designWarnings)}\nnot pushed (--strict).\n`);
        return 1;
      }
    }
    const changes = await configChanges(client, cbid, file, replace);
    if (changes.length === 0) {
      io.stderr(`No changes: ${cbid}'s config already matches.\n`);
      return 0;
    }
    io.stdout(`${formatChanges(changes)}\n`);
    if (sub === 'diff') {
      io.stderr(`${changes.length} change${changes.length === 1 ? '' : 's'} (nothing sent). Apply with: cookiemunch config push --site ${cbid} ${p.positional[2]}${replace ? ' --replace' : ''}\n`);
      return p.flags['exit-code'] === true ? 1 : 0;
    }
    const saved = (replace
      ? await client.sites.putConfig(cbid, { ...file, cbid } as never)
      : await client.sites.patchConfig(cbid, file as never)) as { designWarnings?: unknown };
    io.stderr(`Applied ${changes.length} change${changes.length === 1 ? '' : 's'} to ${cbid}.\n`);
    const found = Array.isArray(saved?.designWarnings) ? (saved.designWarnings as Parameters<typeof formatDesignWarnings>[0]) : [];
    if (found.length) io.stderr(`${formatDesignWarnings(found)}\n${summaryLine(found)}\n`);
    return 0;
  }
  throw new UsageError(`unknown config command: ${sub ?? '(none)'} — use pull, diff, push or validate`);
}

async function previewCommand(p: Parsed, io: CliIo, client: CookieMunchClient): Promise<number> {
  const cbid = requireSite(p, io);
  const ttl = str(p.flags, 'ttl');
  const ttlSeconds = ttl === undefined ? undefined : Number(ttl);
  if (ttlSeconds !== undefined && (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 3600)) {
    throw new UsageError('--ttl must be a whole number of seconds from 1 to 3600');
  }
  const r = await client.sites.previewToken(cbid, {
    ...(str(p.flags, 'region') ? { region: str(p.flags, 'region')! } : {}),
    ...(str(p.flags, 'lang') ? { lang: str(p.flags, 'lang')! } : {}),
    ...(str(p.flags, 'url') ? { url: str(p.flags, 'url')! } : {}),
    ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
  });
  if (p.flags.json === true) {
    io.stdout(`${JSON.stringify(r, null, 2)}\n`);
  } else if (r.previewUrl) {
    io.stdout(`${r.previewUrl}\n`);
  } else {
    // No page to put it on (the site has no domain and no --url): hand over the token.
    io.stdout(`${r.token}\n`);
    io.stderr('Add ?cm_preview=<token>&cm_region=..&cm_lang=.. to any page of the site.\n');
  }
  io.stderr(`Valid until ${new Date(r.expiresAt).toISOString()}.\n`);
  if (p.flags.open === true && r.previewUrl) await io.openUrl(r.previewUrl);
  return 0;
}

async function executorsCommand(
  sub: string | undefined,
  p: Parsed,
  io: CliIo,
  base: string,
  key: string,
  client: CookieMunchClient,
): Promise<number> {
  if (sub === 'webhook-test') {
    const id = p.positional[2];
    if (!id) throw new UsageError('executors webhook-test <id> needs the connection id');
    const headersFile = str(p.flags, 'headers-file');
    const bodyFile = str(p.flags, 'body-file');
    if (!headersFile || !bodyFile) throw new UsageError('--headers-file and --body-file are both required');
    let headers: unknown;
    try {
      headers = JSON.parse(await io.readFile(headersFile));
    } catch {
      throw new UsageError(`${headersFile} is not a JSON object of header name to value`);
    }
    if (!isPlainObject(headers)) throw new UsageError(`${headersFile} is not a JSON object of header name to value`);
    // The body is sent exactly as read: the signature is over these bytes, so no trimming.
    const body = await io.readFile(bodyFile);
    const r = await client.fulfillment.testExecutorWebhook(id, { headers: headers as Record<string, string>, body });
    io.stdout(`${JSON.stringify(r, null, 2)}\n`);
    return r.verified ? 0 : 1;
  }
  if (sub === 'deliveries') {
    const id = p.positional[2];
    if (!id) throw new UsageError('executors deliveries <id> needs the connection id');
    io.stdout(`${JSON.stringify(await client.fulfillment.executorWebhookDeliveries(id), null, 2)}\n`);
    return 0;
  }
  if (sub === 'presets') {
    io.stdout(`${JSON.stringify(await client.fulfillment.executorPresets(), null, 2)}\n`);
    return 0;
  }
  if (sub === 'upgrade-preset') {
    const id = p.positional[2];
    if (!id) throw new UsageError('executors upgrade-preset <id> needs the connection id');
    const version = str(p.flags, 'version');
    if (version !== undefined && !/^[1-9]\d*$/.test(version)) throw new UsageError('--version must be a positive whole number');
    const preset = str(p.flags, 'preset');
    const orgId = str(p.flags, 'org-id');
    const atlasIdAppId = str(p.flags, 'atlas-id-app-id');
    const input = {
      ...(preset ? { preset: preset as never } : {}),
      ...(version ? { presetVersion: Number(version) } : {}),
      ...(orgId ? { orgId } : {}),
      ...(atlasIdAppId ? { atlasIdAppId } : {}),
    };
    const r =
      p.flags['dry-run'] === true
        ? await client.fulfillment.dryRunUpgradeExecutorPreset(id, input)
        : await client.fulfillment.upgradeExecutorPreset(id, input);
    io.stdout(`${JSON.stringify(r, null, 2)}\n`);
    return 0;
  }
  if (sub !== 'test') throw new UsageError(`unknown executors command: ${sub ?? '(none)'} — use test, webhook-test, deliveries, presets or upgrade-preset`);
  const id = p.positional[2];
  if (!id) throw new UsageError('executors test <id> needs the connection id');
  const canary = p.flags.canary === true;
  const email = str(p.flags, 'email');
  if (canary && email) throw new UsageError('use --email or --canary, not both');
  if (!email && !canary) throw new UsageError('--email (or --canary) is required');
  // The API's operations are locate, export and erase. `lookup` was this CLI's documented
  // default and the API refused it (400), so it stays accepted as another name for locate.
  const asked = str(p.flags, 'operation') ?? 'locate';
  const operation = asked === 'lookup' ? 'locate' : asked;
  // The typed SDK has no method for this yet, so it is a direct call with the same key.
  try {
    const r = await rawRequest(io, base, key, 'POST', `/dsar/executors/${encodeURIComponent(id)}/test`, canary ? { canary: true, operation } : { email, operation });
    io.stdout(`${JSON.stringify(r, null, 2)}\n`);
    // A canary test is a health check: a failing one fails the command, so it can gate a deploy.
    return canary && (r as { ok?: unknown }).ok === false ? 1 : 0;
  } catch (e) {
    // The API's generic route miss is a bare `not found`; an unknown connection says so.
    if (e instanceof CookieMunchApiError && e.status === 404 && e.message === 'not found') {
      io.stderr('This server does not offer connection tests yet (POST /v1/dsar/executors/{id}/test).\n');
      return 1;
    }
    throw e;
  }
}

async function scanCommand(p: Parsed, io: CliIo, client: CookieMunchClient): Promise<number> {
  const cbid = requireSite(p, io);
  const timeout = str(p.flags, 'timeout');
  const timeoutS = timeout === undefined ? 120 : Number(timeout);
  if (!Number.isFinite(timeoutS) || timeoutS < 1 || timeoutS > 3600) throw new UsageError('--timeout must be a number of seconds from 1 to 3600');
  let started: Awaited<ReturnType<CookieMunchClient['sites']['scan']>> | null = null;
  try {
    started = await client.sites.scan(cbid);
  } catch (e) {
    if (!(e instanceof CookieMunchApiError && e.status === 409)) throw e;
    io.stderr(`A scan of ${cbid} is already running${p.flags.wait === true ? '; waiting for it' : ''}.\n`);
    if (p.flags.wait !== true) return 0;
  }
  if (p.flags.wait !== true) {
    io.stdout(`${JSON.stringify(started, null, 2)}\n`);
    return 0;
  }
  const r = await client.sites.waitForScan(cbid, { timeoutMs: timeoutS * 1000 });
  io.stdout(`${JSON.stringify(r, null, 2)}\n`);
  if (r.state === 'failed') {
    io.stderr(`Scan ${r.scanId ?? ''} failed: ${r.error ?? 'no reason given'}\n`);
    return 1;
  }
  if (r.status === 'scanning') {
    io.stderr(`Scan ${r.scanId ?? ''} is still running after ${timeoutS} s.\n`);
    return 1;
  }
  const n = r.cookieCount ?? 0;
  const pages = r.pagesVisited !== undefined ? ` on ${r.pagesVisited} page${r.pagesVisited === 1 ? '' : 's'}` : '';
  const kept = r.keptFromEarlier ? `, ${r.keptFromEarlier} kept from earlier crawls and visits` : '';
  const took = r.durationMs !== undefined ? ` in ${Math.round(r.durationMs / 1000)} s` : '';
  const landed = r.finalUrl ? ` (redirected to ${r.finalUrl})` : '';
  io.stderr(`Scan ${r.scanId ?? ''} done${took}: ${n} cookie${n === 1 ? '' : 's'} seen${pages}${kept}${landed}.\n`);
  return 0;
}

const PRESET_VENDORS = ['atlas', 'forumulate', 'chatly', 'cookiemunch', 'referally'] as const;
type Vendor = (typeof PRESET_VENDORS)[number];

function vendorArg(v: string | undefined): Vendor {
  if (!v || !(PRESET_VENDORS as readonly string[]).includes(v)) throw new UsageError(`a vendor is required: ${PRESET_VENDORS.join(', ')}`);
  return v as Vendor;
}

/** `--param k=v` (repeatable) → an object; `true`/`false` become booleans, `cookieDays` a number. */
function presetParams(p: Parsed): Record<string, string | boolean | number> {
  const raw = str(p.flags, 'param');
  const out: Record<string, string | boolean | number> = {};
  for (const line of raw ? raw.split('\n') : []) {
    const eq = line.indexOf('=');
    if (eq <= 0) throw new UsageError(`--param takes key=value, got "${line}"`);
    const v = line.slice(eq + 1);
    const k = line.slice(0, eq);
    out[k] = v === 'true' ? true : v === 'false' ? false : k === 'cookieDays' && /^\d+$/.test(v) ? Number(v) : v;
  }
  return out;
}

/** `cookiemunch cookies …`: vendor presets and removing what real-visit beacons stored (CKM-S-02, S-29). */
async function cookiesCommand(sub: string | undefined, p: Parsed, io: CliIo, client: CookieMunchClient): Promise<number> {
  const dry = p.flags['dry-run'] === true ? { dryRun: true as const } : undefined;
  const print = (v: unknown) => io.stdout(`${JSON.stringify(v, null, 2)}\n`);
  if (sub === 'presets') {
    print(await client.sites.cookiePresets(requireSite(p, io)));
    return 0;
  }
  if (sub === 'preset' || sub === 'unpreset') {
    const cbid = requireSite(p, io);
    const vendor = vendorArg(p.positional[2]);
    if (sub === 'unpreset') {
      print(await client.sites.removeCookiePreset(cbid, vendor, dry));
      return 0;
    }
    const r = await client.sites.applyCookiePreset(cbid, vendor, presetParams(p), dry);
    print(r);
    if (r.note) io.stderr(`${r.note}\n`);
    for (const s of r.skipped ?? []) io.stderr(`skipped ${s.name}: ${s.reason}\n`);
    if (r.manifest.status === 'waiting_on_vendor') io.stderr(`Built-in rows: ${r.manifest.waitingOn} does not publish a manifest yet (${r.manifest.item}).\n`);
    return 0;
  }
  if (sub === 'delete-observed') {
    const cbid = requireSite(p, io);
    const name = p.positional[2];
    if (!name) throw new UsageError('a cookie name is required');
    if (dry) print(await client.sites.deleteObservedCookie(cbid, name, dry));
    else {
      await client.sites.deleteObservedCookie(cbid, name);
      io.stderr(`Removed ${name}.\n`);
    }
    return 0;
  }
  if (sub === 'purge-observed') {
    const cbid = requireSite(p, io);
    const since = str(p.flags, 'since');
    if (!since) throw new UsageError('--since is required (ISO-8601 or epoch ms)');
    const until = str(p.flags, 'until');
    const r = await client.sites.purgeObservedCookies(cbid, { since, ...(until ? { until } : {}) }, dry);
    print(r);
    io.stderr(`${dry ? 'Would remove' : 'Removed'} ${r.count} row${r.count === 1 ? '' : 's'}.\n`);
    return 0;
  }
  throw new UsageError(`unknown cookies command: ${sub ?? '(none)'}`);
}

/** Run the CLI. Returns the process exit code: 0 ok, 1 failed, 2 usage. */
export async function run(argv: string[], io: CliIo): Promise<number> {
  let p: Parsed;
  try {
    p = parseArgs(argv);
  } catch (e) {
    io.stderr(`${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const [cmd, sub] = p.positional;
  if (!cmd || p.flags.help === true || cmd === 'help') {
    io.stdout(USAGE);
    return cmd || p.flags.help === true ? 0 : 2;
  }
  const key = io.env.COOKIEMUNCH_API_KEY;
  if (!key) {
    io.stderr('COOKIEMUNCH_API_KEY is not set. Create a key under Developers in the dashboard.\n');
    return 2;
  }
  const base = io.env.COOKIEMUNCH_BASE_URL || DEFAULT_BASE_URL;
  const client = createCookieMunch({ apiKey: key, baseUrl: base, fetch: io.fetch, userAgent: userAgent(io), ...(io.env.COOKIEMUNCH_STRICT_FIELDS === '1' ? { strictUnknownFields: true } : {}) });
  try {
    if (cmd === 'config') return await configCommand(sub, p, io, client);
    if (cmd === 'preview') return await previewCommand(p, io, client);
    if (cmd === 'scan') return await scanCommand(p, io, client);
    if (cmd === 'cookies') return await cookiesCommand(sub, p, io, client);
    if (cmd === 'executors') return await executorsCommand(sub, p, io, base, key, client);
    const helpers = {
      requireSite: () => requireSite(p, io),
      site: () => str(p.flags, 'site') ?? io.env.COOKIEMUNCH_SITE,
      readJson: (path: string | undefined) => readConfigFile(io, path),
      usage: (m: string) => new UsageError(m),
      flag: (name: string) => p.flags[name],
    };
    if (cmd === 'site') return await siteCommand(sub, io, client, helpers);
    if (cmd === 'health') return await healthCommand(io, client, helpers);
    if (cmd === 'provision') return await provisionCommand(sub, io, client, helpers);
    if (cmd === 'keys') return await keysCommand(sub, io, client, helpers);
    if (cmd === 'partners') return await partnersCommand(sub, p.positional.slice(2), io, client, helpers);
    if (cmd === 'rights-page') {
      return await rightsPageCommand(sub, p, io, client, {
        requireSite: () => requireSite(p, io),
        readJson: (path) => readConfigFile(io, path),
        usage: (m) => new UsageError(m),
      });
    }
    throw new UsageError(`unknown command: ${cmd}`);
  } catch (e) {
    if (e instanceof UsageError) {
      io.stderr(`${e.message}\n\n${USAGE}`);
      return 2;
    }
    if (e instanceof CookieMunchApiError) {
      io.stderr(`API error ${e.status}${e.code ? ` (${e.code})` : ''}: ${e.message}\n`);
      return 1;
    }
    io.stderr(`${(e as Error).message ?? String(e)}\n`);
    return 1;
  }
}
