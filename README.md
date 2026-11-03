# @cookiemunch/cli

`cookiemunch`: the [Cookie Munch](https://cookiemunch.net) Developer API from a terminal or a CI job. Keep a site's banner config in git, preview the banner, run the declaration presets, scan a site, and manage the hosted rights page, all with one API key.

```bash
npm install -g @cookiemunch/cli      # or run any command with: npx @cookiemunch/cli ...
export COOKIEMUNCH_API_KEY=fck_...   # Dashboard > Developers > API keys

cookiemunch config pull --site acme-com-9f3k --out cookiemunch.json
cookiemunch config diff --site acme-com-9f3k cookiemunch.json
cookiemunch config push --site acme-com-9f3k cookiemunch.json
```

`config diff` shows what a push would change (the server's own dry run) and sends nothing; the read-only fields a pulled file carries (`effective`, `designWarnings`, ...) are ignored, so an unedited pull reports "No changes". Add `--replace` to compare against a whole-document replace, `--exit-code` to fail a CI job when something differs.

## Commands

`config pull|diff|push|validate`, `preview`, `scan`, `cookies presets|preset|unpreset|retire|unretire|delete-observed`, `rights-page pull|diff|push|publish`, `executors ...`, `site`, `health`, `keys`, `partners`, `provision`, `doctor`, `scan-source [dir]` (cookie and storage names your source sets, as cookiemunch.json rows; no key), `types [--out file] [--for react,embed]` (a `.d.ts` of the site's categories for `@cookiemunch/react` and/or `@cookiemunch/sdk/embed`). Run `cookiemunch --help` for every flag.

`cookiemunch doctor [--site <cbid>] [--org <id>]` checks your setup in one go: the key (and whose organisation it belongs to, against `--org` or `COOKIEMUNCH_ORG`), its expiry, the CLI version against the latest, and integration health. It exits `1` when a check fails, so it works as a CI step.

## Environment

| Variable | Required | Description |
| --- | --- | --- |
| `COOKIEMUNCH_API_KEY` | yes | An API key (`cookiemunch_live_...`). |
| `COOKIEMUNCH_ORG` | no | The organisation `doctor` checks the key against when no `--org` is given. |
| `COOKIEMUNCH_SITE` | no | The site (`cbid`) used when a command is given no `--site`. |
| `COOKIEMUNCH_BASE_URL` | no | The API origin. Default `https://api.cookiemunch.net`. |
| `COOKIEMUNCH_USER_AGENT` | no | The `User-Agent` sent to the API. Default `cookiemunch-cli/<version>`. |

Exit codes: `0` success, `1` the API refused or the network failed (or `--strict` found a design warning), `2` a usage mistake.

If a call fails with `403 error code: 1010`, the request carried no real `User-Agent`; see the error-codes page below.

## Documentation

Full reference: <https://cookiemunch.net/docs/cli>. Release notes: [CHANGELOG.md](./CHANGELOG.md).
