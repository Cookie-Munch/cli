# Changelog: @cookiemunch/cli

Every published release, newest first. Dates are the day the version was cut.

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
