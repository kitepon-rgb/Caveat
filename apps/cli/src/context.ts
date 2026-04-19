import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  loadConfig,
  findCaveatHome,
  resolvePaths,
  type Logger,
  type CaveatConfig,
  type ResolvedPaths,
} from '@caveat/core';

export interface CliContext {
  caveatHome: string;
  userHome: string;
  userConfigPath: string;
  config: CaveatConfig;
  paths: ResolvedPaths;
  logger: Logger;
}

export interface ContextOverrides {
  caveatHome?: string;
  userHome?: string;
}

export function buildContext(logger: Logger, overrides: ContextOverrides = {}): CliContext {
  const userHome = overrides.userHome ?? homedir();
  const caveatHome = overrides.caveatHome ?? findCaveatHome(userHome);
  const userConfigPath = join(userHome, '.caveatrc.json');
  const config = loadConfig(userConfigPath);
  const paths = resolvePaths(caveatHome, config.knowledgeRepo, userHome);
  return { caveatHome, userHome, userConfigPath, config, paths, logger };
}
