# Changelog: @cookiemunch/cli

Every published release, newest first. Dates are the day the version was cut.

## 0.16.0

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
