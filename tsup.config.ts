import { defineConfig } from 'tsup';
export default defineConfig({
  entry: { index: 'src/index.ts', bin: 'src/bin.ts' },
  format: ['esm'],
  dts: false,
  clean: true,
  sourcemap: true,
  external: ['@cookiemunch/sdk'],
});
