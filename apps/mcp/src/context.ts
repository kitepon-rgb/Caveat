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

export interface McpContext {
  caveatHome: string;
  userHome: string;
  userConfigPath: string;
  config: CaveatConfig;
  paths: ResolvedPaths;
  logger: Logger;
  db: DatabaseSync;
  cwd: string;
}

export interface McpContextOverrides {
  caveatHome?: string;
  userHome?: string;
  cwd?: string;
  logger?: Logger;
}

export function buildMcpContext(overrides: McpContextOverrides = {}): McpContext {
  const userHome = overrides.userHome ?? homedir();
  const caveatHome = overrides.caveatHome ?? findCaveatHome(userHome);
  const userConfigPath = join(userHome, '.caveatrc.json');
  const logger = overrides.logger ?? stderrLogger;
  const config = loadConfig(userConfigPath);
  const paths = resolvePaths(caveatHome, config.knowledgeRepo, userHome);
  const cwd = overrides.cwd ?? process.cwd();
  const db = openDb({ path: paths.dbPath, logger });
  return { caveatHome, userHome, userConfigPath, config, paths, logger, db, cwd };
}
