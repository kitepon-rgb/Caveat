import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Single source of truth for the CLI version: read directly from package.json
 * at runtime so `caveat --version` never drifts from the published version.
 *
 * After bundling via tsup, `import.meta.url` resolves to `dist/index.js`, and
 * `../package.json` resolves to the CLI package's own package.json — which
 * npm/pnpm ships alongside dist/ (required by the `files` field).
 */
function resolveVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf-8')) as {
      version?: unknown;
    };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const CAVEAT_VERSION = resolveVersion();
