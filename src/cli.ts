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
 *   cookiemunch executors conformance <baseUrl> --secret-env <NAME> [--canary-email <addr>] [--prefix /privacy] [--json]
 *   cookiemunch executors conformance --connection <id> [--json]
 *   cookiemunch executors roll-completion-secret <id>
 *   cookiemunch executors upgrade-preset <id> [--preset <name>] [--version <n>] [--org-id <id>] [--atlas-id-app-id <id>]
 *                      [--revoke-atlas-id-grant] [--accept-preset <path> …] [--dry-run]
 *   cookiemunch executors recheck <id>
 *   cookiemunch executors health <id> [--limit <n>]
 *   cookiemunch rights-page pull|diff|push|publish --site <cbid> [<file>] [--base <updatedAt>] [--yes]
 *   cookiemunch scan         --site <cbid> [--wait] [--timeout <seconds>]
 *   cookiemunch cookies presets|preset|unpreset|delete-observed|purge-observed --site <cbid> …
 *   cookiemunch site update  --site <cbid> [--domain <host>] [--name <name>] [--aliases a,b] [--dry-run]
 *   cookiemunch site brand   --site <cbid> [--url <https URL> | <brand.json>] [--dry-run]
 *   cookiemunch health       [--site <cbid>] [--json] [--fail-on error|warning|never]
 *   cookiemunch provision    <file> [--dry-run]
 *   cookiemunch partners     list|link|unlink --site <cbid> …
 *   cookiemunch consent-sync status|rotate|remove|token --site <cbid> …
 *   cookiemunch csp          --merge <vendors|urls> [--framework next|express|nginx] [--site <cbid>]
 *
 * Everything goes through the typed SDK (@cookiemunch/sdk) except where the SDK has no
 * method yet; those calls go through `rawRequest` with the same key and base URL. All I/O
 * is injected, so the whole CLI is testable with a mocked fetch.
 */

import { createCookieMunch, CookieMunchApiError, exchangeOperatorToken, mintConsentSyncToken, runExecutorConformance, type CookieMunchClient } from '@cookiemunch/sdk';
import { diffJson, formatChanges, isPlainObject, mergeLikeServer, withoutReadOnly, type Change, type Json } from './diff.js';
import { rightsPageCommand } from './rights-page.js';
import { healthCommand, keysCommand, partnersCommand, provisionCommand, siteCommand } from './integrations.js';
import { countBySeverity, formatDesignWarnings, summaryLine } from './design-warnings.js';
import { cspCommand } from './csp.js';
import { bundleCommand, cookiesFileCommand, doctorCommand, dsarTestCommand, executorsFileCommand, keysExtraCommand, sandboxCommand, versionCommand, type OpsHelpers } from './ops.js';

export const DEFAULT_BASE_URL = 'https://api.cookiemunch.net';

export interface CliIo {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readFile: (path: string) => Promise<string>;
  /** `mode` is the file mode for a new file (0o600 for anything holding a secret). */
  writeFile: (path: string, data: string, mode?: number) => Promise<void>;
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
  cookiemunch executors conformance <baseUrl> --secret-env <NAME> [--canary-email <addr>]
                      [--prefix /privacy] [--json]
      Check any system against the open cm-standard-v2 executor contract, rule by
      rule, using only the canary subject. The credential is read from the
      environment variable NAME, never from the command line. Without
      --canary-email the organisation's canary address is fetched (needs
      COOKIEMUNCH_API_KEY); with it, no Cookie Munch key is needed at all.
      Exits 1 when any rule fails.
  cookiemunch executors conformance --connection <id> [--json]
      The same suite, run by Cookie Munch against a connected system.
  cookiemunch executors roll-completion-secret <id>
      A new completion secret for that connection, printed once; the old one keeps
      verifying for 24 hours.
  cookiemunch executors upgrade-preset <id> [--preset <name>] [--version <n>]
                      [--org-id <id>] [--atlas-id-app-id <id>] [--revoke-atlas-id-grant]
                      [--accept-preset <path> …] [--dry-run]
      Rebuild a connection from its preset's latest version (or --version), keeping
      its id and credentials; --preset adopts one on a hand-written connection.
      Your hand edits are kept (the diff marks them kept or conflict); --accept-preset
      (repeatable) takes the preset's value for that path. Prints the diff; --dry-run
      changes nothing. A pinned connection is refused.
  cookiemunch executors recheck <id>
      Re-check a connection now (a canary test that records its health): the hook to
      run after deploying that system's rights API. Exits 1 when it is not ok.
  cookiemunch executors health <id> [--limit <n>]
      The connection's last health checks, newest first (up to 50).
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
      The declaration presets (atlas, forumulate, chatly, cookiemunch, referalli, firstpromoter,
      partnerstack, tapfiliate, impact; referally is the deprecated old name of referalli): what each takes,
      what it declared on this site, and whether the vendor's own manifest exists yet.
  cookiemunch cookies preset <vendor> --site <cbid> [--param k=v …] [--dry-run]
      Declare what that platform writes (cookies and browser storage), marked as
      declared by it; run again to re-sync. Atlas: --param frontendApiHost=auth.example.com
      [--param crossSubdomainCookies=false] [--param publishableKey=pk_live_…]. Chatly:
      --param publicId=ch_web_… [--param storage=deny] [--param tracking=false].
      Referral and affiliate presets (referalli, firstpromoter, partnerstack, tapfiliate, impact):
      [--param cookieDomain=.example.com] [--param cookieDays=60] [--param category=…];
      referalli [--param legacyName=false], impact [--param campaignId=…]. A row filed under a
      disabled category prints a warning and a suggestedConfigPatch. Any other vendor is
      declared with the API (PUT /v1/sites/{cbid}/cookies).
  cookiemunch cookies unpreset <vendor> --site <cbid> [--dry-run]
      Remove every declaration that vendor's preset made.
  cookiemunch cookies import-manifest <url> --site <cbid> [--file <manifest.json>] [--dry-run]
      Declare any vendor's cookies and storage from its embed manifest
      (/.well-known/<product>-embed.json), by URL or from a file. Remove it with
      cookies unpreset <product>.
  cookiemunch cookies suggestions --site <cbid>
      What to declare: the platforms detected on the site and each undeclared row.
  cookiemunch cookies declare-suggestions --site <cbid> [--names a,b] [--dry-run]
      Declare them: detected vendors' presets, then every other suggestion with a purpose.
  cookiemunch cookies delete-observed <name> --site <cbid> [--dry-run]
      Remove every stored row of that name (a name the site never sets). A declaration stays.
  cookiemunch cookies purge-observed --site <cbid> --since <time> [--until <time>] [--dry-run]
      Remove every row a real visit first reported in that window (ISO-8601 or epoch ms).
      Crawled rows and declarations stay. Run with --dry-run first.
  cookiemunch site update --site <cbid> [--domain <host>] [--name <name> | --clear-name]
                          [--aliases <a,b>] [--dry-run]
      Rename or move a site. The cbid and consent ledger stay; a domain move clears
      verification. --dry-run prints the diff and its effects without saving.
  cookiemunch site brand --site <cbid> [--url <https URL> | <brand.json>] [--dry-run]
      Import a brand.json into the banner theme (the rights page uses it too). Values the
      site set itself are kept. With neither --url nor a file, prints the last import.
  cookiemunch consent-sync status --site <cbid>
      Whether hosted consent sync is set up (the secret's last four characters, when it was minted).
  cookiemunch consent-sync rotate --site <cbid>
      Mint the site's consent-sync signing secret, or replace it (the old one stops at once).
      Prints the secret alone on stdout, so it can be piped into your secret store: it is shown once.
  cookiemunch consent-sync remove --site <cbid> --yes
      Remove it: hosted consent sync stops for every visitor.
  cookiemunch consent-sync token --site <cbid> --subject <id> [--ttl <seconds>]
      Sign a test token locally with COOKIEMUNCH_CONSENT_SYNC_SECRET (nothing is sent), e.g. to try
      GET /api/v1/<cbid>/profile with curl.
  cookiemunch health [--site <cbid>] [--json] [--fail-on error|warning|never]
      Every link the site's privacy wiring depends on, with a fix hint for each that
      fails. Exits 1 when a check fails (checks that could not run, or are waived, do not count).
      --fail-on error ignores warnings; --fail-on never always exits 0.
  cookiemunch provision <file> [--dry-run]
      Wire a product's privacy in one call (site, connections, Atlas, Forumulate) from
      a JSON file without secrets: the Atlas key and Forumulate token come from
      COOKIEMUNCH_ATLAS_SECRET_KEY and COOKIEMUNCH_FORUMULATE_TOKEN. Re-running is a
      no-op. Exits 1 when a step failed.
  cookiemunch keys report [--unused-days <n>] [--expiring-days <n>] [--json]
      Key hygiene: keys unused for n days (default 90), keys with broad access, and
      keys expiring within n days (default 14). Needs a full-access key.
  cookiemunch partners list|link|unlink --site <cbid> [--partner <id>]
                       [--external-id <id>] [--label <text>] [<linkId>]
      Grant a partner platform the site's consent events (no secret is created), list
      the grants, or revoke one. Any partner this deployment knows (forumulate, atlas, chatly,
      referalli, or one registered for it).
  cookiemunch token exchange --subject-token-env NAME --scope <a,b> --resource org:<id>|site:<cbid> [--expires-in <s>]
      Swap your identity provider's token (read from the variable NAME) for a short-lived, scoped
      API key (at most 1 hour); prints the key alone. Needs no API key.
  cookiemunch csp --merge <vendors|urls> [--framework next|express|nginx] [--site <cbid>]
      One Content-Security-Policy from several products' embed manifests
      (/.well-known/<product>-embed.json): cookiemunch, atlas, chatly, forumulate,
      referalli, or any manifest URL. --framework prints it for next.config.js,
      Express or nginx; without it, the header value. --site uses your site's own
      Cookie Munch manifest (its logo, fonts, sync endpoint). Needs no API key. Exits 1
      when a named product has not published a manifest (the rest are still merged).
  cookiemunch cookies diff|push <file> --site <cbid> [--replace] [--exit-code]
      Declarations as a file ({"cookies": [...]}), through the server's dry run. push applies
      only when something differs; --replace also removes declarations the file leaves out.
  cookiemunch executors pull [<file>] | diff <file> | push <file> [--secret-env NAME]
      Connected systems as a file. The file never carries a secret: a new connection's API key
      comes from the environment variable --secret-env names.
  cookiemunch dsar test [--types access,deletion] [--with-cbid --site <cbid>] [--without-cbid]
                        [--email <addr>] [--cleanup]
      File TEST rights requests and read each back. --cleanup deletes exactly the ones this run
      filed (by id; it never deletes by listing).
  cookiemunch doctor [--site <cbid>] [--org <id>]
      The key (and whose org it is, against --org or COOKIEMUNCH_ORG), its expiry, the CLI
      version against the latest, and integration health. Exits 1 when a check fails.
  cookiemunch keys vend --scopes <a,b> --ttl <1h|30m|seconds> [--cbids <x,y>] [--name <n>]
      A short-lived key (at most 12 h) within this key's own scopes; prints the key alone.
      Needs keys:write (or a full-access key).
  cookiemunch keys self | rotate-self
      This key's own prefix, scopes and expiry; or rotate it (the new key is printed once).
  cookiemunch sandbox [show] | create [--key-name <n>] | delete [--yes]
      The organisation's sandbox: a separate test organisation with the same people and plan
      features, never billed; its keys are test keys and its rights requests are all tests.
      create makes it (or reuses it) and prints a new key for it alone; delete erases it and
      everything in it, after asking. create and delete need a full-access key or orgs:create.
  cookiemunch plan [cookiemunch.json] [--exit-code] [--json]
  cookiemunch apply [cookiemunch.json] [--secret-env NAME] [--secrets-out <file>]
      One file for a site: {site, config, cookies, presets, executors, webhooks, rightsPage,
      partners}, no secrets. plan prints the server's dry run of every part ("No changes" when
      it matches); apply applies them in dependency order and logs each. New webhook secrets
      go to --secrets-out (mode 0600).
  cookiemunch --version | version [--json]
      The CLI version; --json adds the API version the server documents.

Every command takes --json for machine-readable output.

Exit codes:
  0  ok, or nothing to change
  1  a difference (with --exit-code), a failure, or a failed check
  2  a usage mistake

Environment:
  COOKIEMUNCH_API_KEY   an API key (cookiemunch_live_…, or a legacy fck_…). Required.
  COOKIEMUNCH_BASE_URL  the API origin. Default ${DEFAULT_BASE_URL}.
  COOKIEMUNCH_SITE      default for --site.
  COOKIEMUNCH_STRICT_FIELDS=1  send Prefer: strict-unknown-fields on writes: a field the
                        API does not know is refused (400 unknown_field), not ignored.
  COOKIEMUNCH_SECRET_RECIPIENT=x25519:<base64>  answers carry once-shown secrets sealed to
                        this key (sealed_secret), never in plaintext.
  COOKIEMUNCH_ORG       the org id doctor checks the key against.
  --idempotency-key <k> send Idempotency-Key on writes: a retry replays the first answer.
`;

/** A usage mistake: exit code 2. */
class UsageError extends Error {}

interface Parsed {
  positional: string[];
  flags: Record<string, string | true>;
}

const BOOLEAN_FLAGS = new Set(['replace', 'exit-code', 'open', 'help', 'json', 'yes', 'strict', 'wait', 'canary', 'dry-run', 'clear-name', 'revoke-atlas-id-grant', 'with-cbid', 'without-cbid', 'cleanup']);

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
      if ((name === 'param' || name === 'accept-preset') && typeof value === 'string' && typeof flags[name] === 'string') flags[name] = `${flags[name]}\n${value}`;
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
export const CLI_VERSION = '0.8.1';

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
    if (p.flags.json === true) io.stdout(`${JSON.stringify({ cbid, designWarnings: r.designWarnings }, null, 2)}\n`);
    else if (r.designWarnings.length) io.stdout(`${formatDesignWarnings(r.designWarnings)}\n`);
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
    if (p.flags.json === true && (sub === 'diff' || changes.length === 0)) io.stdout(`${JSON.stringify({ cbid, changes }, null, 2)}\n`);
    if (changes.length === 0) {
      io.stderr(`No changes: ${cbid}'s config already matches.\n`);
      return 0;
    }
    if (p.flags.json !== true) io.stdout(`${formatChanges(changes)}\n`);
    if (sub === 'diff') {
      io.stderr(`${changes.length} change${changes.length === 1 ? '' : 's'} (nothing sent). Apply with: cookiemunch config push --site ${cbid} ${p.positional[2]}${replace ? ' --replace' : ''}\n`);
      return p.flags['exit-code'] === true ? 1 : 0;
    }
    const saved = (replace
      ? await client.sites.putConfig(cbid, { ...file, cbid } as never)
      : await client.sites.patchConfig(cbid, file as never)) as { designWarnings?: unknown };
    io.stderr(`Applied ${changes.length} change${changes.length === 1 ? '' : 's'} to ${cbid}.\n`);
    const found = Array.isArray(saved?.designWarnings) ? (saved.designWarnings as Parameters<typeof formatDesignWarnings>[0]) : [];
    if (p.flags.json === true) io.stdout(`${JSON.stringify({ cbid, applied: changes, designWarnings: found }, null, 2)}\n`);
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

async function consentSyncCommand(sub: string | undefined, p: Parsed, io: CliIo, client: CookieMunchClient): Promise<number> {
  const cbid = requireSite(p, io);
  if (sub === 'status') {
    io.stdout(`${JSON.stringify(await client.consentSyncSecret.get(cbid), null, 2)}\n`);
    return 0;
  }
  if (sub === 'rotate') {
    const r = await client.consentSyncSecret.rotate(cbid);
    io.stdout(p.flags.json === true ? `${JSON.stringify(r, null, 2)}\n` : `${r.secret}\n`);
    io.stderr('This secret is shown once: store it on your server (never in a page). A previous secret stopped working.\n');
    return 0;
  }
  if (sub === 'remove') {
    if (p.flags.yes !== true) throw new UsageError('consent-sync remove stops hosted consent sync for every visitor: add --yes');
    await client.consentSyncSecret.remove(cbid);
    io.stderr(`Hosted consent sync is off for ${cbid}.\n`);
    return 0;
  }
  if (sub === 'token') {
    const secret = io.env.COOKIEMUNCH_CONSENT_SYNC_SECRET;
    if (!secret) throw new UsageError('set COOKIEMUNCH_CONSENT_SYNC_SECRET to the site\'s consent-sync secret');
    const subject = str(p.flags, 'subject');
    if (!subject) throw new UsageError('--subject <id> is required');
    const ttl = str(p.flags, 'ttl');
    try {
      const token = mintConsentSyncToken({ secret, cbid, subject, ...(ttl !== undefined ? { ttlSeconds: Number(ttl) } : {}) });
      io.stdout(p.flags.json === true ? `${JSON.stringify({ token }, null, 2)}\n` : `${token}\n`);
    } catch (e) {
      throw new UsageError((e as Error).message);
    }
    return 0;
  }
  throw new UsageError(`unknown consent-sync command: ${sub ?? '(none)'} — use status, rotate, remove or token`);
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
  if (sub === 'conformance') return conformanceCommand(p, io, client);
  if (sub === 'roll-completion-secret') {
    const id = p.positional[2];
    if (!id) throw new UsageError('executors roll-completion-secret <id> needs the connection id');
    io.stdout(`${JSON.stringify(await client.fulfillment.rollExecutorCompletionSecret(id), null, 2)}\n`);
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
    const accept = str(p.flags, 'accept-preset');
    const input = {
      ...(preset ? { preset: preset as never } : {}),
      ...(version ? { presetVersion: Number(version) } : {}),
      ...(orgId ? { orgId } : {}),
      ...(atlasIdAppId ? { atlasIdAppId } : {}),
      ...(p.flags['revoke-atlas-id-grant'] === true ? { revokeAtlasIdGrant: true } : {}),
      ...(accept ? { acceptPreset: accept.split('\n') } : {}),
    };
    const r =
      p.flags['dry-run'] === true
        ? await client.fulfillment.dryRunUpgradeExecutorPreset(id, input)
        : await client.fulfillment.upgradeExecutorPreset(id, input);
    io.stdout(`${JSON.stringify(r, null, 2)}\n`);
    return 0;
  }
  if (sub === 'recheck') {
    const id = p.positional[2];
    if (!id) throw new UsageError('executors recheck <id> needs the connection id');
    const r = await client.fulfillment.recheckExecutor(id);
    io.stdout(`${JSON.stringify(r, null, 2)}\n`);
    // A deploy hook: a failing check fails the step.
    return r.ok === false ? 1 : 0;
  }
  if (sub === 'health') {
    const id = p.positional[2];
    if (!id) throw new UsageError('executors health <id> needs the connection id');
    const limit = str(p.flags, 'limit');
    if (limit !== undefined && !/^[1-9]\d*$/.test(limit)) throw new UsageError('--limit must be a whole number from 1 to 50');
    io.stdout(`${JSON.stringify(await client.fulfillment.executorHealthHistory(id, limit ? { limit: Number(limit) } : {}), null, 2)}\n`);
    return 0;
  }
  if (sub !== 'test') throw new UsageError(`unknown executors command: ${sub ?? '(none)'} — use test, webhook-test, deliveries, presets, upgrade-preset, conformance, roll-completion-secret, recheck or health`);
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

/** One rule per line: PASS/FAIL/SKIP, its id, and what was seen when it did not pass. */
function printConformance(io: CliIo, report: { ok: boolean; passed: number; failed: number; skipped: number; rules: Array<{ id: string; title: string; status: string; detail?: string }> }, asJson: boolean): number {
  if (asJson) {
    io.stdout(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    for (const r of report.rules) {
      io.stdout(`${r.status.toUpperCase().padEnd(4)}  ${r.id}  ${r.title}\n`);
      if (r.detail && r.status !== 'pass') io.stdout(`      ${r.detail}\n`);
    }
    io.stdout(`\n${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped\n`);
  }
  return report.ok ? 0 : 1;
}

async function conformanceCommand(p: Parsed, io: CliIo, client: CookieMunchClient | null): Promise<number> {
  const asJson = p.flags.json === true;
  const connection = str(p.flags, 'connection');
  if (connection) {
    if (!client) throw new UsageError('--connection runs on Cookie Munch: set COOKIEMUNCH_API_KEY');
    return printConformance(io, await client.fulfillment.executorConformance(connection), asJson);
  }
  const baseUrl = p.positional[2];
  if (!baseUrl) throw new UsageError('executors conformance <baseUrl> --secret-env <NAME> (or --connection <id>)');
  const secretEnv = str(p.flags, 'secret-env');
  if (!secretEnv) throw new UsageError('--secret-env <NAME> names the environment variable holding the executor credential');
  const secret = io.env[secretEnv];
  if (!secret) throw new UsageError(`the environment variable ${secretEnv} is empty`);
  let canaryEmail = str(p.flags, 'canary-email');
  if (!canaryEmail) {
    if (!client) throw new UsageError('pass --canary-email, or set COOKIEMUNCH_API_KEY to use your organisation\'s canary address');
    canaryEmail = (await client.fulfillment.executorPresets()).canaryEmail;
  }
  const prefix = str(p.flags, 'prefix');
  let report;
  try {
    report = await runExecutorConformance({ baseUrl, secret, canaryEmail, fetch: io.fetch, ...(prefix ? { prefix } : {}) });
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  return printConformance(io, report, asJson);
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

const PRESET_VENDORS = ['atlas', 'forumulate', 'chatly', 'cookiemunch', 'referalli', 'firstpromoter', 'partnerstack', 'tapfiliate', 'impact'] as const;
/** Old preset names still accepted (the server answers them with a Deprecation header). */
const PRESET_ALIASES: Record<string, Vendor> = { referally: 'referalli' };
type Vendor = (typeof PRESET_VENDORS)[number];

function vendorArg(v: string | undefined): Vendor {
  if (v && Object.prototype.hasOwnProperty.call(PRESET_ALIASES, v)) return PRESET_ALIASES[v]!;
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
  // A custom preset (import-manifest) is removed by its product id, which no list here knows.
  if (sub === 'unpreset' && p.positional[2] && !(PRESET_VENDORS as readonly string[]).includes(p.positional[2])) {
    print(await client.sites.removeCookiePreset(requireSite(p, io), p.positional[2], dry));
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
  // Any vendor's embed manifest as a preset; what to declare; declare it (CMU-X36, CMU-D15).
  if (sub === 'import-manifest') {
    const cbid = requireSite(p, io);
    const src = p.positional[2];
    const file = str(p.flags, 'file');
    if (!src && !file) throw new UsageError('a manifest URL (https://…/.well-known/<product>-embed.json) or --file <manifest.json> is required');
    const input = file ? { manifest: JSON.parse(await io.readFile(file)) as never } : { url: src! };
    const r = await client.sites.importCookieManifest(cbid, input, dry);
    print(r);
    for (const s of r.skipped ?? []) io.stderr(`skipped ${s.name}: ${s.reason}\n`);
    return 0;
  }
  if (sub === 'suggestions') {
    const r = await client.sites.cookieSuggestions(requireSite(p, io));
    print(r);
    io.stderr(`${r.suggestions.length} suggestion${r.suggestions.length === 1 ? '' : 's'}; ${r.vendors.length} platform${r.vendors.length === 1 ? '' : 's'} detected.\n`);
    return 0;
  }
  if (sub === 'declare-suggestions') {
    const cbid = requireSite(p, io);
    const names = str(p.flags, 'names');
    const r = await client.sites.declareCookieSuggestions(cbid, names ? { names: names.split(',').map((n) => n.trim()).filter(Boolean) } : {}, dry);
    print(r);
    io.stderr(`${dry ? 'Would declare' : 'Declared'} ${r.declaredCount} row${r.declaredCount === 1 ? '' : 's'} and ${r.presetsApplied.length} preset${r.presetsApplied.length === 1 ? '' : 's'}.\n`);
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
  // CMU-B15: a leading --version (or -V) prints the version and needs no key. Only leading: `--version <n>`
  // is a value flag of `executors upgrade-preset`.
  if (argv[0] === '--version' || argv[0] === '-V') return versionCommand(io, CLI_VERSION, io.env.COOKIEMUNCH_BASE_URL || DEFAULT_BASE_URL, argv.includes('--json'));
  let p: Parsed;
  try {
    p = parseArgs(argv);
  } catch (e) {
    io.stderr(`${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const [cmd, sub] = p.positional;
  // `version [--json]` needs no key either.
  if (cmd === 'version') {
    return versionCommand(io, CLI_VERSION, io.env.COOKIEMUNCH_BASE_URL || DEFAULT_BASE_URL, p.flags.json === true);
  }
  if (!cmd || p.flags.help === true || cmd === 'help') {
    io.stdout(USAGE);
    return cmd || p.flags.help === true ? 0 : 2;
  }
  // The conformance kit checks the open contract against any system; with --canary-email it
  // needs no Cookie Munch key at all, so anyone implementing the contract can run it.
  if (cmd === 'executors' && sub === 'conformance' && !io.env.COOKIEMUNCH_API_KEY && str(p.flags, 'canary-email')) {
    try {
      return await conformanceCommand(p, io, null);
    } catch (e) {
      if (e instanceof UsageError) {
        io.stderr(`${e.message}\n`);
        return 2;
      }
      throw e;
    }
  }
  const base = io.env.COOKIEMUNCH_BASE_URL || DEFAULT_BASE_URL;
  // Token exchange (CMU-X33) needs no API key: it is how you get one. The subject token is read from the
  // environment variable --subject-token-env names, never from the command line (shell history, ps).
  if (cmd === 'token' && p.positional[1] === 'exchange') {
    const envName = str(p.flags, 'subject-token-env');
    const subjectToken = envName ? io.env[envName] : undefined;
    const scope = (str(p.flags, 'scope') ?? '').split(/[,\s]+/).filter(Boolean);
    const resource = str(p.flags, 'resource');
    const exp = str(p.flags, 'expires-in');
    if (!envName || !subjectToken) { io.stderr(`token exchange needs --subject-token-env NAME, naming a variable that holds your identity provider's token\n`); return 2; }
    if (!scope.length) { io.stderr('token exchange needs --scope a,b (an exchanged key is never full access)\n'); return 2; }
    if (!resource || !/^(org|site):.+/.test(resource)) { io.stderr('token exchange needs --resource org:<id> or site:<cbid>\n'); return 2; }
    if (exp !== undefined && !/^\d+$/.test(exp)) { io.stderr('--expires-in must be a number of seconds\n'); return 2; }
    try {
      const r = await exchangeOperatorToken({
        subjectToken, scope, resource: resource as `org:${string}`, baseUrl: base, fetch: io.fetch,
        ...(exp !== undefined ? { expiresIn: Number(exp) } : {}),
      });
      // The key alone on stdout, so `export COOKIEMUNCH_API_KEY=$(cookiemunch token exchange …)` works.
      io.stdout(p.flags.json === true ? `${JSON.stringify(r, null, 2)}\n` : `${r.accessToken}\n`);
      return 0;
    } catch (e) {
      io.stderr(`${(e as Error).message}\n`);
      return 1;
    }
  }
  // Every embed manifest is public: csp needs no key.
  if (cmd === 'csp') {
    try {
      const merge = str(p.flags, 'merge');
      const framework = str(p.flags, 'framework');
      const site = str(p.flags, 'site') ?? io.env.COOKIEMUNCH_SITE;
      return await cspCommand(
        { apiBase: base, ...(merge ? { merge } : {}), ...(framework ? { framework } : {}), ...(site ? { site } : {}) },
        io,
        (m) => new UsageError(m),
      );
    } catch (e) {
      if (e instanceof UsageError) {
        io.stderr(`${e.message}\n\n${USAGE}`);
        return 2;
      }
      io.stderr(`${(e as Error).message ?? String(e)}\n`);
      return 1;
    }
  }
  const key = io.env.COOKIEMUNCH_API_KEY;
  if (!key) {
    io.stderr('COOKIEMUNCH_API_KEY is not set. Create a key under Developers in the dashboard.\n');
    return 2;
  }
  const client = createCookieMunch({
    apiKey: key, baseUrl: base, fetch: io.fetch, userAgent: userAgent(io),
    ...(io.env.COOKIEMUNCH_STRICT_FIELDS === '1' ? { strictUnknownFields: true } : {}),
    ...(io.env.COOKIEMUNCH_SECRET_RECIPIENT ? { secretRecipient: io.env.COOKIEMUNCH_SECRET_RECIPIENT } : {}),
    ...(typeof p.flags['idempotency-key'] === 'string' ? { headers: { 'Idempotency-Key': p.flags['idempotency-key'] } } : {}),
  });
  const ops: OpsHelpers = {
    requireSite: () => requireSite(p, io),
    site: () => str(p.flags, 'site') ?? io.env.COOKIEMUNCH_SITE,
    readJson: (path) => readConfigFile(io, path),
    usage: (m) => new UsageError(m),
    flag: (name) => p.flags[name],
    positional: p.positional,
  };
  try {
    if (cmd === 'cookies' && (sub === 'diff' || sub === 'push')) return await cookiesFileCommand(sub, io, client, ops);
    if (cmd === 'executors' && (sub === 'pull' || sub === 'diff' || sub === 'push')) return await executorsFileCommand(sub, io, client, ops);
    if (cmd === 'dsar' && sub === 'test') return await dsarTestCommand(io, client, ops);
    if (cmd === 'doctor') return await doctorCommand(io, client, ops, CLI_VERSION);
    if (cmd === 'keys' && sub && sub !== 'report') return await keysExtraCommand(sub, io, client, ops);
    if (cmd === 'sandbox') return await sandboxCommand(sub, io, client, ops);
    if (cmd === 'plan' || cmd === 'apply') return await bundleCommand(cmd, io, client, ops);
    if (cmd === 'config') return await configCommand(sub, p, io, client);
    if (cmd === 'preview') return await previewCommand(p, io, client);
    if (cmd === 'scan') return await scanCommand(p, io, client);
    if (cmd === 'consent-sync') return await consentSyncCommand(sub, p, io, client);
    if (cmd === 'cookies') return await cookiesCommand(sub, p, io, client);
    if (cmd === 'executors') return await executorsCommand(sub, p, io, base, key, client);
    const helpers = {
      requireSite: () => requireSite(p, io),
      site: () => str(p.flags, 'site') ?? io.env.COOKIEMUNCH_SITE,
      readJson: (path: string | undefined) => readConfigFile(io, path),
      usage: (m: string) => new UsageError(m),
      flag: (name: string) => p.flags[name],
    };
    if (cmd === 'site') return await siteCommand(sub, io, client, helpers, p.positional[2]);
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
