import { defineConfig } from 'tsup';
import { cp } from 'node:fs/promises';

export default defineConfig({
  entry: ['src/**/*.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node22',
  bundle: false,
  async onSuccess() {
    await cp('src/schema.sql', 'dist/schema.sql');
    await cp('src/migrations', 'dist/migrations', { recursive: true });
  },
});
