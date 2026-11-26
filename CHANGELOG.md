# Changelog: @cookiemunch/cli

Every published release, newest first. Dates are the day the version was cut.

## 0.29.0 (2026-11-25)

- Added: `site tenants list|get|create|update|delete|import`. `import` sends a JSON list 100 at a time and can be run again to resume; `delete` needs `--yes` or `--dry-run`.
- Added: `site move --to <host>` moves a site to a new domain in one call; `health --pre-deploy`.
- Changed: `plan` lists a connection the file leaves out (one `executors connect` made) as managed, and never as a change. It warns when a site's config is still the default. A refusal prints its fix hint and `didYouMean`.

## 0.28.0 (2026-11-25)

- Added: `apply --yes` / `-y` skips the confirmation; `csp --no-hashes` leaves inline-script hashes out (with a warning about what that allows), and a missing vendor manifest fails loudly. `csp --merge` knows lucida and seolyticize.
- Fixed: cookie rows in a category the same file's config adds are checked after the config part, in `plan` and `apply`. A bare JSON array is read as `{"cookies": [...]}`.

## 0.27.6 (2026-11-18)

- Added: `init` writes `"$schema": "https://cookiemunch.net/schemas/cookiemunch-v1.json"`, so editors autocomplete and check the file.

## 0.27.5 (2026-11-18)

- Added: a file with only `site.domain` plans `+ create site <domain>`; `apply` creates the site (or finds the existing one for that domain), writes its cbid into the file and goes on.
- Changed: rows a preset's own vendor pushed to the site are summed up in one line and kept, not reported as "your own row" each.

## 0.27.4 (2026-11-18)

- Changed: a flag a command does not take prints one line and that command's usage, not the whole help; `--file` names the positional path (`plan does not take --file: the file is positional (cookiemunch plan x.json)`).
- Changed: `plan`/`apply` leave the domain's www/apex twin out of `site.aliases` with a note, instead of failing on `alias_is_domain`.

## 0.27.3 (2026-11-18)

- Fixed: `executors push` (and the executors part of `plan`/`apply`) compares a file's `params` with the connection's `presetParams`, and `mintFrom`/`externalId` with its `mint`, so pushing the same file twice changes nothing. Before, every push reported changes.
- Added: `mintFrom` on a connection that holds a pasted key is a change: the push sends `PATCH {mintFrom, externalId}`, and the partner mints a key that replaces it. `executors pull` writes `mintFrom`/`externalId` for minted connections.
- Needs the API from 2026-11-17 or later.

## 0.27.2 (2026-11-17)

- Fixed: `executors test --canary` grades by contract: only a cm-standard-v2 connection must find the canary; a v1 or vendor connection answering `no_match` passes (exit 0).

## 0.27.1 (2026-11-16)

- Fixed: `--canary` does not grade a connection whose profile has no lookup step.

## 0.27.0 (2026-11-16)

- Added: `partners update <id> --site <cbid> [--external-id …] [--label …] [--dry-run]` edits a link in place; the grant stays.
- Added: `executors test --canary` exits 1 when a connection that must find the canary does not.
- Changed: `partners link` names the account id the partner needs (its `externalIdLabel`).

## 0.26.0 (2026-11-16)

- Added: `cookiemunch whoami`.
- Added: an executors entry with `mintFrom` is created with no key; each entry may name its own `secretEnv` (`--secret-env` is the fallback), and every variable is checked before anything is sent.
- Added: `_` and `x-` keys are comments at the top of a file, of each part and of each executors/webhooks entry; `${env:NAME}` is expanded in strings, and an unset one fails first.
- Changed: a refusal prints one line; the usage block is kept for wrong invocations. A rights identity whose key set is not reachable yet is pending, and the run exits 3.

## 0.25.0 (2026-11-16)

- Fixed: `plan` and `apply` give the same answer on `handOver`. Both send the file's cookies part and presets to the server as one run, and the server judges the hand-over on the outcome, so a row that is already handed over passes (a retry no longer fails with "no preset in this file declares them").
- Changed: `apply` stores the `cookies` part and every preset except `custom` in one all-or-nothing call (`POST /v1/sites/{cbid}/cookies/apply`). A refused apply writes nothing; before, your own rows could be removed and the preset not yet re-applied.
- Needs the API from 2026-11-16 or later.

## 0.24.0 (2026-11-13)

- Changed: `cookies suggestions` prints a table (one line per platform detected, then one per suggestion: name, storage, category, preset or confidence, reason); `--json` prints the document as before.

## 0.23.0 (2026-11-13)

- Fixed: `cookies list --source preset` shows the preset rows your own rows hide (`shadowed`) for a preset applied before 0.22, read from each applied preset's dry run, with the preset's own category.
- Fixed: with `--json`, the `cookies` commands write only the JSON document to stdout and nothing to stderr (the notes are in the document), so output still parses when a runner merges the two streams.

## 0.22.0 (2026-11-13)

- Added: `"handOver": ["lc_consent", …]` in `cookiemunch.json`: each named own row is removed alone and the preset in the file that declares it takes it over; other own rows are untouched. `plan` refuses a name no preset in the file declares.
- Added: `cookies list --source preset` also lists a preset row your own row hides, marked `shadowed` (`"shadowed": true` with `--json`).
- Changed: a partner grant the key may not make no longer stops `plan`: it is listed as `blocked:` with the server's fix, the other parts are still planned, and `--exit-code` exits 1.
- Changed: a preset on built-in rows names its revision (`built-in rows (builtin:<hash>)`), and an instance preset's revision is `instance:<hash>`, so two runs print the same revision until what it declares changes.

## 0.21.0 (2026-11-12)

- Added: `cookies list --site <cbid> [--source preset|own|observed] [--vendor <v>] [--json]`: what the published declaration lists, with each row's category and where it came from.
- Changed: `plan` lists each declaration a preset adds, changes or removes, with its category (the first 25; `--detail` for all), and names the revision in force on a preset with nothing to do.
- Changed: `plan` names your own cookie rows the file leaves out (they are kept), and rows of yours that a preset also declares. `"replaceCookies": true` in the file removes the rows it leaves out, so a preset can take them over.

## 0.20.1 (2026-11-12)

- Fixed: a `partners` entry in the plan file no longer crashes `plan` on a first declaration. `resource` defaults to the file's site and `scopes` to `["consent:read"]`, as documented.
- Fixed: `plan` compares `externalId`, `label` and `events` on partner links. A site consent grant is planned with the server's dry run of `POST /v1/sites/{cbid}/partners`, and a link replaced by a different `externalId` shows as `+`/`-` (apply revokes the old one).
- Fixed: the help says strict unknown fields are the default; `COOKIEMUNCH_STRICT_FIELDS=0` sends `Prefer: lenient-unknown-fields`.

## 0.20.0 (2026-11-11)

- Added: `executors conformance --test-subject` also checks the subject's export holds no credential (`requests.access.no_secrets`).
- Added: `csp --merge` knows `hermetica` and `watchtower`.
- Changed: tracks `@cookiemunch/sdk` 0.23.0.

## 0.19.0 (2026-11-11)

- Added: the plan file carries `rightsIdentity`, `rightsCaptcha`, `dsar` and `mailProvider` (secrets only by `secretEnv`); `plan` names the vendor or system on every line.
- Added: `scan --cookies-file` for a signed-in crawl; `executors connect --param name=value` and `upgrade-preset --param`.
- Added: executor suggestions and the Lucida, Hermetica and Watchtower presets.

## 0.18.2 (2026-11-07)

- Added: `doctor` fails when a host is on more than one site of the organisation, naming the host and both sites, with or without `--site`.

## 0.18.1 (2026-11-05)

- Fixed: `site update --keep-old-domain` works, and a switch given a value is read as written or refused, so `--dry-run=true` no longer does the write. `init` checks `--out` before creating a site, uses the web site for a domain and finds a site by its alias. `apply` checks `--secrets-out` before creating webhooks and saves the secrets it has if a later create fails. A file that can't be read says so. `partners list`, `link` and `unlink` each take only their own flags.

## 0.18.0 (2026-11-05)

- Changed: every command refuses a flag it would ignore, read from its own help entry, and a stray word; a script passing either now exits 2. init stops when --out is a file it cannot read as a site's. doctor names what fails and the first fix, and takes --fail-on. A connect missing orgId names --org-id and puts it in the next command. Added: executors conformance --erase-subject <email> --yes. plan and apply list --site, partners --dry-run, executors push --defer, executors diff --exit-code.

## 0.17.1 (2026-11-05)

- Fixed: a refused mint prints its reason and code (the API answers 424). doctor --site fails on a site that does not exist, and doctor and dsar test refuse flags they would ignore. init stops before creating a site when --out is for another one. dsar test --site files for that site. connect --defer prints the API warning, the dry-run warning is plain text, the default system name skips api and www, and a wrong key with --base-url gets a fix line. --fix-plan gives one step per action.

## 0.17.0 (2026-11-05)

- `executors connect` checks the key first: a refused key stores nothing and exits 1. New: `--no-verify`, `--base-url`, `--system`; `--defer` now registers a pending connection. An existing connection is named, with a command that can succeed.
- `init` refuses a non-hostname `--domain`, reuses a site with that domain, and leaves an existing `--out` file alone.
- Unknown flags are refused by name; `connect`, `activate` and `init` also refuse known flags they would ignore.
- `activate` lists the failing rules, `dsar test` prints warnings, `plan --json` carries `presets`, `doctor --fix-plan` names sites and only mentions scopes the key lacks. `conformance --test-subject`. Help lists exit 3.

## 0.16.0 (2026-11-05)

- `executors connect`, `executors activate`, `init`, `doctor --fix-plan`, `plan --detail`, `apply --presets-only`, `executors push --defer`.
- `plan --exit-code` exits 3 when only upstream presets drifted. `pinned` on a preset.
- Conformance prints the fix first. Installs a `cm` alias. `preview --screenshot`.

## 0.15.0 (2026-11-04)

- Added: `plan` and `config push` print `not applied: <path> (the server's dry run does not keep it)` for any field sent that the server would not store; `plan --exit-code` then exits 1.

## 0.14.0 (2026-11-04)

- Added: `config translate --site <cbid> [--languages] [--dry-run]`: the site's own banner and category copy, on its connected translation account.

## 0.13.0 (2026-11-03)

- Added: the `seolyticize` preset and the `none` storage type, with `@cookiemunch/sdk` 0.16.0.

## 0.12.1 (2026-11-03)

- Added: `doctor --site <cbid>` warns `preset_incomplete` for each applied preset that misses names the site writes.
- Added: `provision` passes `atlas.connect: true` through (step `atlas.connect`).

## 0.12.0 (2026-11-03)

- Added: `scan-source [dir] [--json]`: the first-party cookie and storage names your source sets, as cookiemunch.json cookie rows (category null); skips node_modules, dist and .next; no key.
- Added: `types --site <cbid> [--out file]`: a `.d.ts` of the site's categories (`CookieMunchCategory`) that narrows `@cookiemunch/react`'s category arguments.

## 0.11.0 (2026-11-02)

- Added: `cookies translation [status|connect|disconnect]` and `cookies translate [--languages] [--names] [--dry-run]`.

## 0.10.0 (2026-11-02)

- Changed: `cookies declare --replace` keeps vendor-preset rows; remove a preset with its own command.

## 0.9.0 (2026-11-01)

- Added: `cookiemunch site update --keep-old-domain` keeps the old domain as an alias during a move. Built on `@cookiemunch/sdk` 0.10.0.

- Added: a webhook in `cookiemunch.json` may name `secretEnv`, an environment variable holding a signing secret you chose; that webhook needs no `--secrets-out`. A `secret` in the file is refused.

## 0.8.1 (2026-10-30)

- Changed: `cookiemunch cookies preset --help` names Atlas's `publishableKey` and Chatly's `storage` and `tracking` params (`--param publishableKey=pk_live_…`, `--param storage=deny`, `--param tracking=false`).

## 0.8.0 (2026-10-30)

- Changed: `cookiemunch csp --merge` keeps a manifest's `'sha256-…'` / `'sha384-…'` / `'sha512-…'` hash sources as written, before the origins.
- Removed: `cookiemunch csp --merge <product>` reads each product's manifest only under its own name (`/.well-known/<product>-embed.json`); the suite-wide fallback is gone.
- Changed: a version 2 `provision` body names its block `stack` (the server still reads the former name).

## 0.7.1 (2026-10-24)

- Changed: `cookiemunch csp --merge <product>` reads each product's manifest under its own name first (`/.well-known/<product>-embed.json`), and the suite-wide manifest name only as a fallback.

## 0.7.0 (2026-10-24)

- Added: `cookiemunch sandbox [show] | create [--key-name <n>] | delete [--yes]`.
- Added: `cookiemunch token exchange --subject-token-env NAME --scope a,b --resource org:<id>|site:<cbid>` — a key for at most an hour from your identity provider's sign-in, no API key needed.

## 0.6.0 (2026-10-24)

- Added: `cookiemunch executors conformance <baseUrl> --secret-env NAME` — checks any system against the open cm-standard-v2 executor contract, no Cookie Munch key needed with `--canary-email`; `--connection <id>` runs it from Cookie Munch.
- Added: `cookiemunch executors roll-completion-secret <id>`.
- Added: `--version` and `version [--json]` (`{ cli, api }`).
- Added: `cookies diff|push <file>`, `executors pull|diff|push <file> [--secret-env NAME]` (files never carry a secret), `dsar test [--types …] [--with-cbid] [--without-cbid] [--cleanup]` (deletes only what it filed), `doctor`.
- Added: `plan` / `apply` over one `cookiemunch.json` bundle, and the `plan-action` GitHub Action that comments the plan on a pull request.
- Added: `keys vend --scopes … --ttl 1h`, `keys self`, `keys rotate-self`; `keys report` lists revoked keys.
- Added: `--json` on every command; `--idempotency-key`; `COOKIEMUNCH_SECRET_RECIPIENT` for sealed secrets; `provision` takes a version 2 body and `--from-step`.
- Changed: `partners link --partner` takes any partner the deployment knows.
- Added: `cookiemunch csp --merge <vendors|urls> [--framework next|express|nginx]` (needs no key), `cookies suggestions` / `declare-suggestions` / `import-manifest`, `site brand`, `health --fail-on`.
- Changed: built on `@cookiemunch/sdk` 0.6.0.

## 0.5.0 (2026-10-23)

- Added: `consent-sync status|rotate|remove --site <cbid>` manages the site's hosted consent-sync secret. `rotate` prints it once.
- Added: `consent-sync token --site <cbid> --subject <id> [--ttl <seconds>]` signs a short-lived sync token for testing.
- Changed: built on `@cookiemunch/sdk` 0.5.0.

## 0.4.2 (2026-10-22)

- Changed: published from the public [Cookie-Munch/cli](https://github.com/Cookie-Munch/cli) repo with npm provenance, so `npm audit signatures` verifies where the package was built. No code changes.

## 0.4.1 (2026-10-22)

- Fixed: `config diff` (and `push`) ignores the read-only fields a pulled file carries (`effective`, `designWarnings`, `warnings`, `rightsFormUrl`, ...). A file from `config pull` now reports "No changes" against the config it came from, with or without `--replace`.
- Changed: the diff is the server's `?dryRun=1` result when it answers, and the local diff otherwise.
- Added: `cookies preset referally` (`--param cookieDomain=`, `cookieDays=`, `category=`).
- Added: requests send `User-Agent: cookiemunch-cli/<version>`.

## 0.4.0 (2026-10-19)

- Added: site, integration health, `provision` and partner-link commands.
- Added: executor presets and canary checks; `cookies presets|preset|unpreset|delete-observed`.

## 0.3.0 (2026-10-15)

- Added: `scan --wait`.
- Added: `cookies retire` and `unretire`.

## 0.2.0 (2026-10-15)

- Added: executor webhook test and delivery log, with `--dry-run`.
- Fixed: design-warning headers say what happened; notices are not blamed on Accept.

## 0.1.1 (2026-10-14)

- Added: `config validate`, design warnings on `push`, and `--strict` for CI.
- Added: `rights-page pull|diff|push|publish` (diff is a server dry run); `publish` asks before going live, `--yes` skips and is required without a terminal.
- Fixed: `executors test` defaults to `locate`; `lookup` is an alias.

## 0.1.0 (2026-10-14)

- First release: `config pull|diff|push`, banner `preview` and connection tests, over the Developer API.
