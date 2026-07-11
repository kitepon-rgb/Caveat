import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildCodexSidecarDiagnosticsCommand,
  buildCodexSidecarReadOnlySmokeCommand,
  buildCodexSidecarRunCommand,
  caveatEntriesToSidecarContextBlocks,
  caveatEntryReferencePath,
  caveatEntryToSidecarContextBlock,
  decideCodexSidecarExecution,
  type GetResult,
} from '../src/index.js';

describe('codex-sidecar context adapter', () => {
  it('converts a caveat entry into a caveat_entry context block', () => {
    const entry = fixtureEntry();

    expect(caveatEntryToSidecarContextBlock(entry)).toEqual(readFixture());
  });

  it('builds stable reference paths for own and community sources', () => {
    expect(caveatEntryReferencePath({ source: 'own', path: 'nodejs/example.md' })).toBe(
      'entries/nodejs/example.md',
    );
    expect(
      caveatEntryReferencePath({
        source: 'community/team-notes',
        path: 'docker/example.md',
      }),
    ).toBe('community/team-notes (sealed or cloned bundle; no local file reference)');
  });

  it('converts multiple entries into context blocks', () => {
    expect(caveatEntriesToSidecarContextBlocks([fixtureEntry()])).toHaveLength(1);
  });
});

describe('codex-sidecar execution policy', () => {
  it('prefers operational Codex sidecar for Claude-hosted read-only review', () => {
    expect(
      decideCodexSidecarExecution({
        hostAgent: 'claude',
        availability: 'operational',
        workflow: 'review',
      }),
    ).toMatchObject({
      useSidecar: true,
      route: 'codex-sidecar',
    });
  });

  it('keeps Claude compatibility mode when sidecar is unavailable', () => {
    expect(
      decideCodexSidecarExecution({
        hostAgent: 'claude',
        availability: 'unavailable',
        workflow: 'risk-check',
      }),
    ).toMatchObject({
      useSidecar: false,
      route: 'claude-compatibility',
    });
  });

  it('prevents Codex-on-Codex recursion without an explicit boundary', () => {
    expect(
      decideCodexSidecarExecution({
        hostAgent: 'codex',
        availability: 'operational',
        workflow: 'explore',
      }),
    ).toMatchObject({
      useSidecar: false,
      route: 'current-codex-session',
    });
  });

  it('allows Codex-on-Codex when structured sidecar output is the boundary', () => {
    expect(
      decideCodexSidecarExecution({
        hostAgent: 'codex',
        availability: 'operational',
        workflow: 'risk-check',
        structuredResultRequired: true,
      }),
    ).toMatchObject({
      useSidecar: true,
      route: 'codex-sidecar',
    });
  });

  it('requires work-capable availability for codex_work', () => {
    expect(
      decideCodexSidecarExecution({
        hostAgent: 'claude',
        availability: 'operational',
        workflow: 'work',
      }),
    ).toMatchObject({
      useSidecar: false,
      route: 'claude-compatibility',
    });

    expect(
      decideCodexSidecarExecution({
        hostAgent: 'claude',
        availability: 'work-capable',
        workflow: 'work',
      }),
    ).toMatchObject({
      useSidecar: true,
      route: 'codex-sidecar',
    });
  });

  it('requires explicit sidecar_agent for automation and unknown hosts', () => {
    expect(
      decideCodexSidecarExecution({
        hostAgent: 'automation',
        availability: 'operational',
        workflow: 'review',
      }),
    ).toMatchObject({
      useSidecar: false,
      route: 'requires-explicit-config',
    });

    expect(
      decideCodexSidecarExecution({
        hostAgent: 'automation',
        availability: 'operational',
        workflow: 'review',
        sidecarAgent: 'codex',
      }),
    ).toMatchObject({
      useSidecar: true,
      route: 'codex-sidecar',
    });
  });
});

describe('codex-sidecar command plans', () => {
  it('builds the preferred diagnostics command', () => {
    expect(buildCodexSidecarDiagnosticsCommand({ projectRoot: '/repo' })).toEqual({
      command: 'codex-sidecar',
      args: ['diagnostics', '--project', '/repo', '--preset', 'review'],
    });
  });

  it('builds a development-path smoke command without hiding the chosen CLI', () => {
    expect(
      buildCodexSidecarReadOnlySmokeCommand({
        projectRoot: '/repo',
        cli: { command: 'node', argsPrefix: ['/dev/codex-sidecar/dist/index.js'] },
      }),
    ).toEqual({
      command: 'node',
      args: [
        '/dev/codex-sidecar/dist/index.js',
        'explore',
        '--project',
        '/repo',
        '--preset',
        'explore',
        'Smoke test only: identify the package that contains Caveat core types. Return one sentence.',
      ],
    });
  });

  it('builds a read-only run command with a context file', () => {
    expect(
      buildCodexSidecarRunCommand({
        workflow: 'risk-check',
        projectRoot: '/repo',
        preset: 'risk',
        prompt: 'Check MCP risks.',
        contextFile: '/tmp/context.json',
        cli: { command: 'node', argsPrefix: ['/dev/codex-sidecar/dist/index.js'] },
      }),
    ).toEqual({
      command: 'node',
      args: [
        '/dev/codex-sidecar/dist/index.js',
        'risk-check',
        '--project',
        '/repo',
        '--preset',
        'risk',
        '--context-file',
        '/tmp/context.json',
        'Check MCP risks.',
      ],
    });
  });

  it('builds a hook advisory run command with the advisory preset', () => {
    expect(
      buildCodexSidecarRunCommand({
        workflow: 'explore',
        projectRoot: '/repo',
        preset: 'advisory',
        prompt: 'Give concise hook advice.',
      }),
    ).toEqual({
      command: 'codex-sidecar',
      args: [
        'explore',
        '--project',
        '/repo',
        '--preset',
        'advisory',
        'Give concise hook advice.',
      ],
    });
  });

  it('builds a work command that can remove the isolated worktree', () => {
    expect(
      buildCodexSidecarRunCommand({
        workflow: 'work',
        projectRoot: '/repo',
        preset: 'work',
        prompt: 'Create a smoke file.',
        preserveWorktree: false,
      }),
    ).toEqual({
      command: 'codex-sidecar',
      args: [
        'work',
        '--project',
        '/repo',
        '--preset',
        'work',
        '--remove-worktree',
        'Create a smoke file.',
      ],
    });
  });
});

function readFixture(): unknown {
  return JSON.parse(
    readFileSync(new URL('./fixtures/codex-sidecar-context-block.json', import.meta.url), 'utf-8'),
  );
}

function fixtureEntry(): GetResult {
  return {
    id: 'hooks-no-hot-reload',
    source: 'own',
    path: 'claude-code/hooks-no-hot-reload.md',
    frontmatter: {
      id: 'hooks-no-hot-reload',
      title: 'Claude Code hooks are not hot reloaded',
      visibility: 'public',
      confidence: 'confirmed',
      outcome: 'resolved',
      tags: ['claude-code', 'hooks'],
      environment: { claude: 'code' },
      source_project: null,
      source_session: '2026-04-22T00:00:00.000Z/abcdef123456',
      created_at: '2026-04-22T00:00:00.000Z',
      updated_at: '2026-04-22T00:00:00.000Z',
      last_verified: '2026-04-22T00:00:00.000Z',
    },
    sections: {
      Symptom:
        'Editing ~/.claude/settings.json while Claude Code is running does not affect the active hook set.',
      Cause: 'Claude Code reads hook config at process startup.',
    },
    body: [
      '## Symptom',
      'Editing ~/.claude/settings.json while Claude Code is running does not affect the active hook set.',
      '',
      '## Cause',
      'Claude Code reads hook config at process startup.',
    ].join('\n'),
  };
}
