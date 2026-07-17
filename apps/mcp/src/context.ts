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
import { triggerAutoSyncAfterWrite } from './autoSyncTrigger.js';

export interface McpContext {
  caveatHome: string;
  userHome: string;
  userConfigPath: string;
  config: CaveatConfig;
  paths: ResolvedPaths;
  logger: Logger;
  db: DatabaseSync;
  /**
   * Called after a write tool mutates own entries. Required (not optional) so
   * that every context constructor — tests included — states whether a write
   * spawns a real background sync.
   */
  onEntryWritten: () => void;
}

export interface McpContextOverrides {
  caveatHome?: string;
  userHome?: string;
  logger?: Logger;
  productVersion?: string;
  onEntryWritten?: () => void;
}

export function buildMcpContext(overrides: McpContextOverrides = {}): McpContext {
  const userHome = overrides.userHome ?? homedir();
  const caveatHome = overrides.caveatHome ?? findCaveatHome(userHome);
  const userConfigPath = join(userHome, '.caveatrc.json');
  const logger = overrides.logger ?? stderrLogger;
  const config = loadConfig(userConfigPath);
  const paths = resolvePaths(caveatHome, config.knowledgeRepo, userHome);
  const db = openDb({ path: paths.dbPath, logger });
  const onEntryWritten =
    overrides.onEntryWritten ?? (() => triggerAutoSyncAfterWrite(caveatHome, logger));
  return { caveatHome, userHome, userConfigPath, config, paths, logger, db, onEntryWritten };
}
