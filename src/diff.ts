/**
 * What a config push would change, computed on this side of the wire.
 *
 * `mergeLikeServer` mirrors the server's `PATCH /v1/sites/{cbid}/config` semantics exactly
 * (JSON Merge Patch, RFC 7386 — packages/server/src/site-config-write.ts mergePatch): the
 * patch wins, nested plain objects merge, arrays and primitives replace wholesale, and a
 * `null` removes the key. A diff computed against any other merge would describe a change
 * the server is not going to make.
 */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export interface Change {
  /** Dotted path; array indices in brackets: `banner.content.title`, `geoRules[0].mode`. */
  path: string;
  kind: 'added' | 'removed' | 'changed';
  from?: Json;
  to?: Json;
}

/**
 * Returned by a config read, never a setting; the server drops them from a write
 * (packages/server/src/site-config-write.ts READ_ONLY_CONFIG_FIELDS, pinned by a test).
 */
export const READ_ONLY_CONFIG_FIELDS = ['effective', 'warnings', 'designWarnings', 'region', 'regulation', 'copy', 'rightsFormUrl', 'version', 'observeToken'] as const;

/** A copy of a config without its read-only fields, so a pulled file diffs clean against the server. */
export function withoutReadOnly(cfg: Record<string, unknown>): Record<string, unknown> {
  const out = { ...cfg };
  for (const k of READ_ONLY_CONFIG_FIELDS) delete out[k];
  return out;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function mergeLikeServer(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const b = base[k];
    if (v === null) delete out[k];
    else out[k] = isPlainObject(v) ? mergeLikeServer(isPlainObject(b) ? b : {}, v) : v;
  }
  return out;
}

function join(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

/** Every leaf that differs between `before` and `after`, in a stable order. */
export function diffJson(before: unknown, after: unknown, path = ''): Change[] {
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((k) => {
      const p = join(path, k);
      if (!(k in after)) return [{ path: p, kind: 'removed' as const, from: before[k] as Json }];
      if (!(k in before)) return [{ path: p, kind: 'added' as const, to: after[k] as Json }];
      return diffJson(before[k], after[k], p);
    });
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const out: Change[] = [];
    const n = Math.max(before.length, after.length);
    for (let i = 0; i < n; i++) {
      const p = `${path}[${i}]`;
      if (i >= after.length) out.push({ path: p, kind: 'removed', from: before[i] as Json });
      else if (i >= before.length) out.push({ path: p, kind: 'added', to: after[i] as Json });
      else out.push(...diffJson(before[i], after[i], p));
    }
    return out;
  }
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  return [{ path: path || '(root)', kind: 'changed', from: before as Json, to: after as Json }];
}

function show(v: Json | undefined): string {
  const s = JSON.stringify(v);
  return s === undefined ? 'undefined' : s.length > 120 ? `${s.slice(0, 117)}...` : s;
}

/** A unified-diff-ish rendering: one line per change. */
export function formatChanges(changes: Change[]): string {
  return changes
    .map((c) =>
      c.kind === 'added'
        ? `+ ${c.path}: ${show(c.to)}`
        : c.kind === 'removed'
          ? `- ${c.path}: ${show(c.from)}`
          : `~ ${c.path}: ${show(c.from)} -> ${show(c.to)}`,
    )
    .join('\n');
}
