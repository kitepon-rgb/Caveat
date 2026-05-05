import type { GetResult, Source } from './types.js';

export type CaveatHostAgent = 'claude' | 'codex' | 'automation' | 'unknown';

export type CodexSidecarAvailability =
  | 'disabled'
  | 'unavailable'
  | 'configured'
  | 'operational'
  | 'work-capable';

export type CodexSidecarWorkflow =
  | 'review'
  | 'explore'
  | 'opinion'
  | 'risk-check'
  | 'work';

export type CodexSidecarAgentSetting = 'codex' | 'disabled' | 'auto';

export type CodexSidecarRoute =
  | 'codex-sidecar'
  | 'claude-compatibility'
  | 'current-codex-session'
  | 'disabled'
  | 'unavailable'
  | 'requires-explicit-config';

export interface CodexSidecarExecutionPolicyInput {
  hostAgent: CaveatHostAgent;
  availability: CodexSidecarAvailability;
  workflow: CodexSidecarWorkflow;
  sidecarAgent?: CodexSidecarAgentSetting;
  requiresIsolation?: boolean;
  structuredResultRequired?: boolean;
  explicitSecondPass?: boolean;
}

export interface CodexSidecarExecutionDecision {
  useSidecar: boolean;
  route: CodexSidecarRoute;
  reason: string;
}

export interface CodexSidecarCliSpec {
  command: string;
  argsPrefix?: string[];
}

export interface CodexSidecarCommandPlan {
  command: string;
  args: string[];
}

export interface CodexSidecarRunCommandInput {
  workflow: CodexSidecarWorkflow;
  projectRoot: string;
  preset?: string;
  prompt?: string;
  contextFile?: string;
  preserveWorktree?: boolean;
  cli?: CodexSidecarCliSpec;
}

export interface SidecarFileReference {
  path: string;
  line?: number;
  label?: string;
}

export interface CaveatSidecarContextBlock {
  kind: 'caveat_entry';
  source: 'caveat';
  trust: 'local';
  summary: string;
  references: SidecarFileReference[];
  data: {
    id: string;
    source: Source;
    title: string;
    tags: string[];
    confidence: string;
    visibility: string;
    outcome?: string;
    environment: Record<string, string>;
    last_verified?: string;
  };
}

export function caveatEntryToSidecarContextBlock(
  entry: GetResult,
): CaveatSidecarContextBlock {
  const fm = entry.frontmatter;
  return {
    kind: 'caveat_entry',
    source: 'caveat',
    trust: 'local',
    summary: summarizeEntry(entry),
    references: [
      {
        path: caveatEntryReferencePath(entry),
        label: 'source caveat',
      },
    ],
    data: {
      id: fm.id,
      source: entry.source,
      title: fm.title,
      tags: fm.tags ?? [],
      confidence: fm.confidence,
      visibility: fm.visibility,
      ...(fm.outcome ? { outcome: fm.outcome } : {}),
      environment: fm.environment ?? {},
      ...(fm.last_verified ? { last_verified: fm.last_verified } : {}),
    },
  };
}

export function caveatEntriesToSidecarContextBlocks(
  entries: readonly GetResult[],
): CaveatSidecarContextBlock[] {
  return entries.map((entry) => caveatEntryToSidecarContextBlock(entry));
}

export function caveatEntryReferencePath(entry: Pick<GetResult, 'source' | 'path'>): string {
  const path = entry.path.replace(/\\/g, '/').replace(/^\/+/, '');
  if (entry.source === 'own') return prefixPath('entries', path);
  return prefixPath(entry.source, prefixPath('entries', path));
}

export function decideCodexSidecarExecution(
  input: CodexSidecarExecutionPolicyInput,
): CodexSidecarExecutionDecision {
  if (input.sidecarAgent === 'disabled' || input.availability === 'disabled') {
    return {
      useSidecar: false,
      route: 'disabled',
      reason: 'Codex sidecar is explicitly disabled.',
    };
  }

  if (input.availability === 'unavailable') {
    return {
      useSidecar: false,
      route: input.hostAgent === 'claude' ? 'claude-compatibility' : 'unavailable',
      reason: 'codex-sidecar is not available for this repository.',
    };
  }

  if (
    (input.hostAgent === 'automation' || input.hostAgent === 'unknown') &&
    input.sidecarAgent !== 'codex'
  ) {
    return {
      useSidecar: false,
      route: 'requires-explicit-config',
      reason: 'Automation and unknown hosts must set sidecar_agent before delegating.',
    };
  }

  if (!availabilityCanRunWorkflow(input.availability, input.workflow)) {
    return {
      useSidecar: false,
      route: input.hostAgent === 'claude' ? 'claude-compatibility' : 'unavailable',
      reason:
        input.workflow === 'work'
          ? 'codex_work requires work-capable sidecar availability.'
          : 'Read-only sidecar execution requires operational availability.',
    };
  }

  if (input.hostAgent === 'codex' && !hasCodexOnCodexBoundary(input)) {
    return {
      useSidecar: false,
      route: 'current-codex-session',
      reason:
        'Codex hosts should not call another Codex unless isolation, structured output, or an explicit second pass is required.',
    };
  }

  return {
    useSidecar: true,
    route: 'codex-sidecar',
    reason:
      input.hostAgent === 'claude'
        ? 'Claude hosts prefer Codex sidecar for independent review, exploration, and risk checks.'
        : 'The request has a distinct sidecar execution boundary.',
  };
}

export function buildCodexSidecarDiagnosticsCommand(input: {
  projectRoot: string;
  preset?: string;
  cli?: CodexSidecarCliSpec;
}): CodexSidecarCommandPlan {
  const cli = input.cli ?? { command: 'codex-sidecar' };
  return {
    command: cli.command,
    args: [
      ...(cli.argsPrefix ?? []),
      'diagnostics',
      '--project',
      input.projectRoot,
      '--preset',
      input.preset ?? 'review',
    ],
  };
}

export function buildCodexSidecarReadOnlySmokeCommand(input: {
  projectRoot: string;
  preset?: 'review' | 'explore' | 'opinion' | 'risk';
  prompt?: string;
  cli?: CodexSidecarCliSpec;
}): CodexSidecarCommandPlan {
  const cli = input.cli ?? { command: 'codex-sidecar' };
  return {
    command: cli.command,
    args: [
      ...(cli.argsPrefix ?? []),
      'explore',
      '--project',
      input.projectRoot,
      '--preset',
      input.preset ?? 'explore',
      input.prompt ??
        'Smoke test only: identify the package that contains Caveat core types. Return one sentence.',
    ],
  };
}

export function buildCodexSidecarRunCommand(
  input: CodexSidecarRunCommandInput,
): CodexSidecarCommandPlan {
  const cli = input.cli ?? { command: 'codex-sidecar' };
  return {
    command: cli.command,
    args: [
      ...(cli.argsPrefix ?? []),
      workflowCommand(input.workflow),
      '--project',
      input.projectRoot,
      ...(input.preset ? ['--preset', input.preset] : []),
      ...(input.contextFile ? ['--context-file', input.contextFile] : []),
      ...(input.preserveWorktree === false ? ['--remove-worktree'] : []),
      ...(input.prompt ? [input.prompt] : []),
    ],
  };
}

function availabilityCanRunWorkflow(
  availability: CodexSidecarAvailability,
  workflow: CodexSidecarWorkflow,
): boolean {
  if (workflow === 'work') return availability === 'work-capable';
  return availability === 'operational' || availability === 'work-capable';
}

function hasCodexOnCodexBoundary(input: CodexSidecarExecutionPolicyInput): boolean {
  return (
    input.workflow === 'work' ||
    input.requiresIsolation === true ||
    input.structuredResultRequired === true ||
    input.explicitSecondPass === true
  );
}

function workflowCommand(workflow: CodexSidecarWorkflow): string {
  return workflow === 'risk-check' ? 'risk-check' : workflow;
}

function summarizeEntry(entry: GetResult): string {
  const title = entry.frontmatter.title.trim();
  const symptom = section(entry, 'Symptom').replace(/\s+/g, ' ').trim();
  if (!symptom) return title;
  return truncate(`${title}: ${symptom}`, 220);
}

function section(entry: GetResult, name: string): string {
  const key = Object.keys(entry.sections).find(
    (candidate) => candidate.trim().toLowerCase() === name.toLowerCase(),
  );
  return key ? (entry.sections[key] ?? '') : '';
}

function prefixPath(prefix: string, path: string): string {
  if (!path) return prefix;
  if (path === prefix || path.startsWith(`${prefix}/`)) return path;
  return `${prefix}/${path}`;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1).trimEnd()}...`;
}
