/**
 * `cookiemunch rights-page pull|diff|push|publish` — the hosted rights page as code.
 *
 * Unlike `config diff`, `diff` asks the server: the rights page has a real dry run, so the
 * diff is against what the server would store (normalised and sanitised), and an invalid
 * file fails with the server's issues before anything is written.
 */
import { CookieMunchApiError, type CookieMunchClient } from '@cookiemunch/sdk';
import type { CliIo } from './cli.js';
import { diffJson, formatChanges } from './diff.js';

interface Helpers { requireSite(): string; readJson(path: string | undefined): Promise<Record<string, unknown>>; usage(msg: string): Error }
type Issue = { path: string; message: string };

const isConflict = (e: unknown) => e instanceof CookieMunchApiError && e.status === 409;

/** `--base <updatedAt>` (epoch ms or an ISO date), else the updatedAt this command just read. */
function baseFrom(flag: string | true | undefined, read: number | null | undefined, h: Helpers): number | string | null {
  if (flag === undefined) return read ?? null;
  if (typeof flag === 'string' && /^\d+$/.test(flag)) return Number(flag);
  if (typeof flag === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(flag) && Number.isFinite(Date.parse(flag))) return flag;
  throw h.usage('--base must be the draft’s updatedAt (epoch ms, as pull prints it, or an ISO date)');
}

function issuesOf(e: unknown): Issue[] | null {
  if (!(e instanceof CookieMunchApiError) || e.status !== 422) return null;
  const body = e.body as { issues?: Issue[]; problems?: Issue[] } | undefined;
  return body?.issues ?? body?.problems ?? [];
}

export async function rightsPageCommand(
  sub: string | undefined,
  p: { positional: string[]; flags: Record<string, string | true> },
  io: CliIo,
  client: CookieMunchClient,
  h: Helpers,
): Promise<number> {
  const cbid = h.requireSite();
  const report = (list: Issue[]) => io.stderr(`${list.map((i) => `  ${i.path || '(document)'}: ${i.message}`).join('\n')}\n`);
  if (sub === 'pull') {
    const { draft, updatedAt } = await client.rightsPage.get(cbid);
    const text = `${JSON.stringify(draft, null, 2)}\n`;
    const out = typeof p.flags.out === 'string' ? p.flags.out : undefined;
    if (out) {
      await io.writeFile(out, text);
      io.stderr(`Wrote ${cbid}'s rights page draft to ${out}\n`);
    } else io.stdout(text);
    if (updatedAt != null) io.stderr(`To refuse a push if anyone saves the draft after this pull, push with: --base ${updatedAt}\n`);
    return 0;
  }
  if (sub === 'diff' || sub === 'push') {
    const file = await h.readJson(p.positional[2]);
    const read = await client.rightsPage.get(cbid);
    const current = read.draft;
    // The base the diff is against (or the one pull printed): a save after it is a conflict, never lost.
    const base = baseFrom(p.flags.base, read.updatedAt, h);
    let proposed: unknown;
    try {
      proposed = (await client.rightsPage.dryRun(cbid, file, { mode: 'put' })).draft;
    } catch (e) {
      const list = issuesOf(e);
      if (!list) throw e;
      io.stderr(`${p.positional[2]} is not a valid rights page:\n`);
      report(list);
      return 1;
    }
    const changes = diffJson(current, proposed);
    if (p.flags.json === true && (sub === 'diff' || !changes.length)) io.stdout(`${JSON.stringify({ cbid, changes }, null, 2)}\n`);
    if (!changes.length) { io.stderr(`No changes: ${cbid}'s rights page draft already matches.\n`); return 0; }
    if (p.flags.json !== true) io.stdout(`${formatChanges(changes)}\n`);
    if (sub === 'diff') {
      io.stderr(`${changes.length} change${changes.length === 1 ? '' : 's'} (nothing saved). Apply with: cookiemunch rights-page push --site ${cbid} ${p.positional[2]}\n`);
      return p.flags['exit-code'] === true ? 1 : 0;
    }
    let saved;
    try {
      saved = await client.rightsPage.put(cbid, file as never, { baseUpdatedAt: base });
    } catch (e) {
      if (!isConflict(e)) throw e;
      io.stderr(`Not saved: ${cbid}'s rights page draft changed since ${p.flags.base !== undefined ? 'the --base you gave' : 'this diff'} (someone else saved it).\n`
        + `See what changed with: cookiemunch rights-page diff --site ${cbid} ${p.positional[2]}\nthen push again.\n`);
      return 1;
    }
    io.stderr(`Saved the draft (${changes.length} change${changes.length === 1 ? '' : 's'}). Nothing is live until: cookiemunch rights-page publish --site ${cbid}\n`);
    if (saved.warnings.length) { io.stderr('It cannot be published yet:\n'); report(saved.warnings); }
    return 0;
  }
  if (sub === 'publish') {
    // Read before asking, so the draft that goes live is the one that existed when you said yes.
    const base = p.flags.base !== undefined ? baseFrom(p.flags.base, null, h) : (await client.rightsPage.get(cbid)).updatedAt ?? null;
    if (p.flags.yes !== true) {
      if (!io.confirm) throw h.usage('rights-page publish puts the draft live and there is no terminal to confirm in. Pass --yes to publish without a prompt.');
      if (!(await io.confirm(`Publish ${cbid}'s rights page draft? It goes live at once. [y/N] `))) {
        io.stderr('Not published.\n');
        return 1;
      }
    }
    try {
      const r = await client.rightsPage.publish(cbid, { baseUpdatedAt: base });
      io.stderr(`Published version ${r.version} of ${cbid}'s rights page.\n`);
      return 0;
    } catch (e) {
      if (isConflict(e)) {
        io.stderr(`Nothing was published: ${cbid}'s rights page draft changed since it was read (someone else saved it).\n`
          + `Review it with: cookiemunch rights-page pull --site ${cbid}\nthen publish again.\n`);
        return 1;
      }
      const list = issuesOf(e);
      if (!list) throw e;
      io.stderr('The rights page cannot be published:\n');
      report(list);
      return 1;
    }
  }
  throw h.usage(`unknown rights-page command: ${sub ?? '(none)'} — use pull, diff, push or publish`);
}
