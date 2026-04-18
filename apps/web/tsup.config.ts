import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/**/*.ts'],
  format: ['esm'],
  dts: { entry: 'src/server.ts' },
  clean: true,
  sourcemap: true,
  target: 'node22',
  bundle: false,
});
