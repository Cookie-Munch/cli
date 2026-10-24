/**
 * `cookiemunch csp --merge <vendors|urls> [--framework next|express|nginx] [--site <cbid>]`
 *
 * One Content-Security-Policy from several products' embed manifests
 * (`/.well-known/forgedeck-embed.json`, schema https://cookiemunch.net/schemas/embed-v1.json):
 * each manifest lists its origins by directive (`csp`) and the non-origin sources it needs
 * (`requires`); the policy is their union, plus `'self'`.
 *
 * Vendor-neutral: `--merge` takes any manifest URL. The names below are first-class shortcuts
 * for products whose manifest host is known — the same host map the API's importer uses
 * (packages/server/src/manifest-importer.ts; a test keeps the two equal). A product that has not
 * published its manifest yet is reported, and the policy is built from the rest.
 *
 * Needs no API key: every manifest is public, `--site` included (`GET /v1/embed?cbid=`).
 */

/** Where a known product publishes its manifest: the apex first, then its API host. */
export const KNOWN_MANIFEST_HOSTS: Readonly<Record<string, readonly string[]>> = {
  cookiemunch: ['cookiemunch.net', 'api.cookiemunch.net'],
  atlas: ['atlasauth.net', 'api.atlasauth.net'],
  chatly: ['chatlychat.com', 'api.chatlychat.com'],
  forumulate: ['forumulate.com'],
  referalli: ['referalli.com'],
};

/** Old names still accepted. */
const ALIASES: Record<string, string> = { referally: 'referalli' };

export const CSP_FRAMEWORKS = ['next', 'express', 'nginx'] as const;
export type CspFramework = (typeof CSP_FRAMEWORKS)[number];

type Surface = { csp?: Record<string, unknown>; requires?: Record<string, unknown> };
type Manifest = { product?: unknown; surfaces?: Record<string, Surface> };

export interface ManifestSource {
  /** What the user named: a vendor or a URL. */
  label: string;
  /** URLs to try, in order. */
  urls: string[];
  product?: string;
}

/** `atlas,chatly,https://x/.well-known/forgedeck-embed.json` → sources to fetch. */
export function manifestSources(list: string, opts: { site?: string; apiBase: string }): { sources: ManifestSource[]; unknown: string[] } {
  const sources: ManifestSource[] = [];
  const unknown: string[] = [];
  for (const raw of list.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (/^https:\/\//i.test(raw)) {
      sources.push({ label: raw, urls: [raw] });
      continue;
    }
    const name = ALIASES[raw.toLowerCase()] ?? raw.toLowerCase();
    const hosts = KNOWN_MANIFEST_HOSTS[name];
    if (!hosts) {
      unknown.push(raw);
      continue;
    }
    if (name === 'cookiemunch' && opts.site) {
      sources.push({ label: `cookiemunch (site ${opts.site})`, urls: [`${opts.apiBase.replace(/\/$/, '')}/v1/embed?cbid=${encodeURIComponent(opts.site)}`], product: name });
      continue;
    }
    sources.push({ label: name, urls: hosts.map((h) => `https://${h}/.well-known/forgedeck-embed.json`), product: name });
  }
  return { sources, unknown };
}

const ORIGIN = /^(https|wss):\/\/[^\s*'"]+$/;
const KEYWORD = /^('unsafe-inline'|'unsafe-eval'|'wasm-unsafe-eval'|'unsafe-hashes'|data:|blob:)$/;

/** The union of every surface's origins and requirements, by directive; `'self'` first. */
export function mergeManifests(manifests: Manifest[]): Map<string, string[]> {
  const byDirective = new Map<string, Set<string>>();
  const add = (directive: string, list: unknown, allowKeywords: boolean) => {
    if (!Array.isArray(list) || !/^[a-z-]+-src$|^form-action$/.test(directive)) return;
    let set = byDirective.get(directive);
    if (!set) byDirective.set(directive, (set = new Set()));
    for (const src of list) {
      if (typeof src !== 'string') continue;
      // A placeholder (`https://{instance}.example.com`) is a tenant's value: it cannot be pasted.
      if (src.includes('{')) continue;
      if (ORIGIN.test(src) || (allowKeywords && KEYWORD.test(src))) set.add(src);
    }
  };
  for (const m of manifests) {
    for (const s of Object.values(m.surfaces ?? {})) {
      for (const [d, list] of Object.entries(s.csp ?? {})) add(d, list, false);
      for (const [d, list] of Object.entries(s.requires ?? {})) add(d, list, true);
    }
  }
  const out = new Map<string, string[]>();
  out.set('default-src', ["'self'"]);
  for (const [d, set] of [...byDirective.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (set.size === 0) continue;
    const keywords = [...set].filter((s) => !ORIGIN.test(s)).sort();
    const origins = [...set].filter((s) => ORIGIN.test(s)).sort();
    out.set(d, ["'self'", ...keywords, ...origins]);
  }
  return out;
}

/** Placeholders a manifest left for the tenant to fill in: reported, never guessed. */
export function placeholders(manifests: Manifest[]): string[] {
  const out = new Set<string>();
  for (const m of manifests) {
    for (const s of Object.values(m.surfaces ?? {})) {
      for (const map of [s.csp, s.requires]) {
        for (const list of Object.values(map ?? {})) {
          if (Array.isArray(list)) for (const src of list) if (typeof src === 'string' && src.includes('{')) out.add(src);
        }
      }
    }
  }
  return [...out].sort();
}

export function policyString(policy: Map<string, string[]>): string {
  return [...policy.entries()].map(([d, list]) => `${d} ${list.join(' ')}`).join('; ');
}

/** The policy as the framework writes it. */
export function renderPolicy(policy: Map<string, string[]>, framework?: CspFramework): string {
  const value = policyString(policy);
  if (framework === 'next') {
    return [
      '// next.config.js',
      'async headers() {',
      '  return [{',
      "    source: '/(.*)',",
      `    headers: [{ key: 'Content-Security-Policy', value: ${JSON.stringify(value)} }],`,
      '  }];',
      '},',
    ].join('\n');
  }
  if (framework === 'express') {
    return `app.use((req, res, next) => { res.setHeader('Content-Security-Policy', ${JSON.stringify(value)}); next(); });`;
  }
  if (framework === 'nginx') return `add_header Content-Security-Policy "${value.replace(/"/g, '\\"')}" always;`;
  return value;
}

/** Fetch one manifest, trying each URL in turn. */
export async function fetchManifest(src: ManifestSource, fetchImpl: typeof fetch): Promise<{ ok: true; manifest: Manifest; url: string } | { ok: false; error: string }> {
  const tried: string[] = [];
  for (const url of src.urls) {
    try {
      const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, redirect: 'manual' });
      if (!res.ok) {
        tried.push(`${url} answered ${res.status}`);
        continue;
      }
      const doc = (await res.json()) as Manifest;
      if (!doc || typeof doc !== 'object' || !doc.surfaces || typeof doc.surfaces !== 'object') {
        tried.push(`${url} is not an embed manifest (no surfaces)`);
        continue;
      }
      if (src.product && doc.product !== src.product) {
        tried.push(`${url} speaks for "${String(doc.product)}", not ${src.product}`);
        continue;
      }
      return { ok: true, manifest: doc, url };
    } catch (e) {
      tried.push(`${url}: ${(e as Error).message}`);
    }
  }
  return { ok: false, error: tried.join('; ') || 'no URL to try' };
}

export interface CspIo {
  fetch: typeof fetch;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export async function cspCommand(
  opts: { merge?: string; framework?: string; site?: string; apiBase: string },
  io: CspIo,
  usage: (message: string) => Error,
): Promise<number> {
  if (!opts.merge) throw usage('--merge is required: vendor names (cookiemunch, atlas, chatly, forumulate, referalli) or manifest URLs, comma-separated');
  if (opts.framework !== undefined && !(CSP_FRAMEWORKS as readonly string[]).includes(opts.framework)) {
    throw usage(`--framework must be one of ${CSP_FRAMEWORKS.join(', ')}`);
  }
  const { sources, unknown } = manifestSources(opts.merge, { apiBase: opts.apiBase, ...(opts.site ? { site: opts.site } : {}) });
  if (unknown.length) throw usage(`unknown vendor: ${unknown.join(', ')}. Name one of ${Object.keys(KNOWN_MANIFEST_HOSTS).join(', ')}, or pass its manifest URL (https://…/.well-known/forgedeck-embed.json).`);
  const manifests: Manifest[] = [];
  let failed = 0;
  for (const src of sources) {
    const r = await fetchManifest(src, io.fetch);
    if (r.ok) manifests.push(r.manifest);
    else {
      failed++;
      io.stderr(`${src.label}: no manifest — ${r.error}\n`);
    }
  }
  if (manifests.length === 0) return 1;
  const policy = mergeManifests(manifests);
  io.stdout(`${renderPolicy(policy, opts.framework as CspFramework | undefined)}\n`);
  const left = placeholders(manifests);
  if (left.length) io.stderr(`Tenant-specific sources left out (fill in your own value): ${left.join(', ')}\n`);
  return failed ? 1 : 0;
}
