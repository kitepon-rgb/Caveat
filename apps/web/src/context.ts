import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  findCaveatHome,
  loadConfig,
  openDb,
  resolvePaths,
  stderrLogger,
  type CaveatConfig,
  type Logger,
  type ResolvedPaths,
} from '@caveat/core';
import type { DatabaseSync } from 'node:sqlite';

export interface WebContext {
  caveatHome: string;
  userHome: string;
  userConfigPath: string;
  config: CaveatConfig;
  paths: ResolvedPaths;
  logger: Logger;
  db: DatabaseSync;
}

export interface WebContextOverrides {
  caveatHome?: string;
  userHome?: string;
  logger?: Logger;
  db?: DatabaseSync;
}

export function buildWebContext(overrides: WebContextOverrides = {}): WebContext {
  const userHome = overrides.userHome ?? homedir();
  const caveatHome = overrides.caveatHome ?? findCaveatHome(userHome);
  const userConfigPath = join(userHome, '.caveatrc.json');
  const logger = overrides.logger ?? stderrLogger;
  const config = loadConfig(userConfigPath);
  const paths = resolvePaths(caveatHome, config.knowledgeRepo, userHome);
  const db = overrides.db ?? openDb({ path: paths.dbPath, logger });
  return { caveatHome, userHome, userConfigPath, config, paths, logger, db };
}
