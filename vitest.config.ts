// Shipped by scripts/mirror-sdks.mjs in the Cookie Munch product repo — edit it there.
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    // The tests import the package by its own name; run them against source, not dist.
    alias: [
      { find: /^@cookiemunch\/cli$/, replacement: here('./src/index.ts') },
    ],
  },
  esbuild: { jsx: 'automatic' },
  test: {
    // Pure logic tests run in node; DOM/React tests opt in per file via
    //   // @vitest-environment happy-dom
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Keep DOM tests hermetic: never hit the network for scripts/iframes/css.
    environmentOptions: {
      happyDOM: {
        settings: {
          disableJavaScriptFileLoading: true,
          disableJavaScriptEvaluation: true,
          disableCSSFileLoading: true,
          disableIframePageLoading: true,
        },
      },
    },
  },
});
