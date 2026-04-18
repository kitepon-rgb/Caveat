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

export interface McpContext {
  toolRoot: string;
  userHome: string;
  userConfigPath: string;
  config: CaveatConfig;
  paths: ResolvedPaths;
  logger: Logger;
  db: DatabaseSync;
  cwd: string;
}

export interface McpContextOverrides {
  toolRoot?: string;
  userHome?: string;
  cwd?: string;
  logger?: Logger;
}

export function buildMcpContext(overrides: McpContextOverrides = {}): McpContext {
  const toolRoot = overrides.toolRoot ?? findToolRoot();
  const userHome = overrides.userHome ?? homedir();
  const userConfigPath = join(userHome, '.caveatrc.json');
  const logger = overrides.logger ?? stderrLogger;
  const config = loadConfigFromPaths(toolRoot, userConfigPath);
  const paths = resolvePaths(toolRoot, config.knowledgeRepo, userHome);
  const cwd = overrides.cwd ?? process.cwd();
  const db = openDb({ path: paths.dbPath, logger });
  return { toolRoot, userHome, userConfigPath, config, paths, logger, db, cwd };
}
