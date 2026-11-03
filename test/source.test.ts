/** `cookiemunch scan-source` and `cookiemunch types`. */
import { describe, it, expect } from 'vitest';
import { run } from '../src/cli.js';
import { scanSourceFiles } from '../src/source.js';
import { harness } from './harness.js';

describe('scan-source', () => {
  it('finds cookie and storage names in source, skipping node_modules, dist and .next', async () => {
    const h = harness({
      env: { COOKIEMUNCH_API_KEY: '' },
      files: {
        'app/a.ts': `document.cookie = "theme=dark; path=/"; localStorage.setItem('draft', x); Cookies.set('ref', id);`,
        'app/b.tsx': "cookies().set('session', t); sessionStorage.setItem(\"tab\", v); res.cookies.set(`cart_${id}`, v); localStorage.setItem('draft', y);",
        'app/c.vue': `<script>window.localStorage.setItem('vue_pref', 1)</script>`,
        'app/readme.md': `localStorage.setItem('not_code', 1)`,
        'app/node_modules/x/index.js': `document.cookie = "vendor=1"`,
        'app/dist/out.js': `localStorage.setItem('built', 1)`,
        'app/.next/x.js': `localStorage.setItem('next_built', 1)`,
      },
    });
    expect(await run(['scan-source', 'app', '--json'], h.io)).toBe(0);
    const { cookies } = JSON.parse(h.out()) as { cookies: unknown[] };
    expect(cookies).toEqual([
      { name: 'cart_*', type: 'cookie', category: null, files: ['b.tsx'] },
      { name: 'draft', type: 'localStorage', category: null, files: ['a.ts', 'b.tsx'] },
      { name: 'ref', type: 'cookie', category: null, files: ['a.ts'] },
      { name: 'session', type: 'cookie', category: null, files: ['b.tsx'] },
      { name: 'tab', type: 'sessionStorage', category: null, files: ['b.tsx'] },
      { name: 'theme', type: 'cookie', category: null, files: ['a.ts'] },
      { name: 'vue_pref', type: 'localStorage', category: null, files: ['c.vue'] },
    ]);
    expect(h.calls).toEqual([]); // no key, no network
  });

  it('prints one line per name without --json', async () => {
    const h = harness({ files: { 'src/x.js': `localStorage.setItem('k', 1)` } });
    expect(await run(['scan-source', 'src'], h.io)).toBe(0);
    expect(h.out()).toBe('k\tlocalStorage\tx.js\n');
  });

  it('skips names built entirely at run time', () => {
    expect(scanSourceFiles([{ path: 'a.js', text: 'document.cookie = `${name}=${v}`' }])).toEqual([]);
  });
});

describe('types', () => {
  it('writes the categories the site offers and the @cookiemunch/react augmentation', async () => {
    const config = { cbid: 'acme', categories: { statistics: { enabled: false }, suite: ['support_chat'], custom: [{ id: 'video', label: 'Video' }, { id: 'old', enabled: false }] } };
    const h = harness({ respond: (c) => (c.url.endsWith('/v1/sites/acme/config') ? { status: 200, body: config } : undefined) });
    expect(await run(['types', '--site', 'acme', '--out', 'types/cm.d.ts'], h.io)).toBe(0);
    const dts = h.written['types/cm.d.ts']!;
    expect(dts).toContain(`export type CookieMunchCategory = 'necessary' | 'preferences' | 'marketing' | 'support_chat' | 'video';`);
    expect(dts).toContain(`declare module '@cookiemunch/react' {`);
    expect(dts).toContain(`    'video': true;`);
    expect(dts).not.toContain('statistics');
  });
});
