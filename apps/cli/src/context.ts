import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  loadConfigFromPaths,
  findToolRoot,
  resolvePaths,
  type Logger,
  type CaveatConfig,
  type ResolvedPaths,
} from '@caveat/core';

export interface CliContext {
  toolRoot: string;
  userHome: string;
  userConfigPath: string;
  config: CaveatConfig;
  paths: ResolvedPaths;
  logger: Logger;
}

export interface ContextOverrides {
  toolRoot?: string;
  userHome?: string;
}

export function buildContext(logger: Logger, overrides: ContextOverrides = {}): CliContext {
  const toolRoot = overrides.toolRoot ?? findToolRoot();
  const userHome = overrides.userHome ?? homedir();
  const userConfigPath = join(userHome, '.caveatrc.json');
  const config = loadConfigFromPaths(toolRoot, userConfigPath);
  const paths = resolvePaths(toolRoot, config.knowledgeRepo, userHome);
  return { toolRoot, userHome, userConfigPath, config, paths, logger };
}
