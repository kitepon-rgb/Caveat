import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export interface CaveatConfig {
  knowledgeRepo: string;
  semverKeys: string[];
  communitySources: string[];
  /**
   * URL of the shared community knowledge DB. Every `caveat init` subscribes
   * to this by default (opt out via `caveat init --skip-shared`). Contributions
   * flow via `caveat push` (fork + PR on GitHub).
   *
   * Users can point this at a private/enterprise shared repo by overriding in
   * `~/.caveatrc.json`.
   */
  sharedRepo: string;
}

export const SHARED_REPO_URL = 'https://github.com/kitepon-rgb/Caveat';

export const DEFAULT_CONFIG: CaveatConfig = {
  knowledgeRepo: 'own',
  semverKeys: ['driver', 'cuda', 'node'],
  communitySources: [],
  sharedRepo: SHARED_REPO_URL,
};

export function loadConfig(userConfigPath: string): CaveatConfig {
  const userCfg = existsSync(userConfigPath)
    ? (JSON.parse(readFileSync(userConfigPath, 'utf-8')) as Partial<CaveatConfig>)
    : {};
  return deepMerge(DEFAULT_CONFIG, userCfg) as CaveatConfig;
}

export function ensureUserConfig(userConfigPath: string): void {
  if (!existsSync(userConfigPath)) {
    writeFileSync(userConfigPath, '{}\n', 'utf-8');
  }
}

function deepMerge(base: unknown, overlay: unknown): unknown {
  if (overlay === null || overlay === undefined) return base;
  if (Array.isArray(overlay)) return overlay;
  if (typeof overlay !== 'object') return overlay;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return overlay;

  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(overlay as Record<string, unknown>)) {
    result[k] = deepMerge(result[k], v);
  }
  return result;
}
