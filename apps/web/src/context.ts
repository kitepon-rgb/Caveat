import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  findToolRoot,
  loadConfigFromPaths,
  openDb,
  resolvePaths,
  stderrLogger,
  type CaveatConfig,
  type Logger,
  type ResolvedPaths,
} from '@caveat/core';
import type { DatabaseSync } from 'node:sqlite';

export interface WebContext {
  toolRoot: string;
  userHome: string;
  userConfigPath: string;
  config: CaveatConfig;
  paths: ResolvedPaths;
  logger: Logger;
  db: DatabaseSync;
}

export interface WebContextOverrides {
  toolRoot?: string;
  userHome?: string;
  logger?: Logger;
  db?: DatabaseSync;
}

export function buildWebContext(overrides: WebContextOverrides = {}): WebContext {
  const toolRoot = overrides.toolRoot ?? findToolRoot();
  const userHome = overrides.userHome ?? homedir();
  const userConfigPath = join(userHome, '.caveatrc.json');
  const logger = overrides.logger ?? stderrLogger;
  const config = loadConfigFromPaths(toolRoot, userConfigPath);
  const paths = resolvePaths(toolRoot, config.knowledgeRepo, userHome);
  const db = overrides.db ?? openDb({ path: paths.dbPath, logger });
  return { toolRoot, userHome, userConfigPath, config, paths, logger, db };
}
