import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type CodexSidecarAdvisory =
  | { status: 'ok'; summary: string; rawEventLogRef?: string }
  | { status: 'failed'; message: string };

function compactFailureMessage(message: string): string {
  const singleLine = message.replace(/\s+/g, ' ').trim();
  if (!singleLine) return 'unknown error';
  return singleLine.length > 220 ? `${singleLine.slice(0, 220)}...` : singleLine;
}

export function formatCodexSidecarAdvisoryUnavailable(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `[caveat:codex-sidecar] advisory unavailable: ${compactFailureMessage(message)}`;
}

function sidecarFailureDetail(output: string): string {
  const protocol = output.match(/PROTOCOL_ERROR:[^"\r\n]+/);
  if (protocol) return compactFailureMessage(protocol[0]!);

  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const diagnostic = lines.find(
    (line) => !line.startsWith('[caveat] [codex-sidecar] codex-sidecar '),
  );
  return compactFailureMessage(diagnostic ?? output);
}

export function runCodexSidecarAdvisory(input: {
  searchText: string;
  limit: number;
  projectRoot: string;
  prompt: string;
}): CodexSidecarAdvisory {
  const cliScript = process.argv[1];
  if (!cliScript) {
    return { status: 'failed', message: 'current Caveat CLI script path is unavailable' };
  }

  const args = [
    ...process.execArgv,
    '--disable-warning=ExperimentalWarning',
    cliScript,
    'codex-sidecar',
    'run',
    'explore',
    input.prompt,
    '--preset',
    'advisory',
    '--query',
    input.searchText,
    '--limit',
    String(Math.max(1, input.limit)),
    '--host-agent',
    'claude',
    '--availability',
    'operational',
  ];
  let resultDir: string | undefined;
  let advisory: CodexSidecarAdvisory;
  try {
    resultDir = mkdtempSync(join(tmpdir(), 'caveat-codex-advisory-'));
    const resultFile = join(resultDir, 'result.json');
    args.push('--save-result', resultFile);

    const nodeCli = process.env.CAVEAT_CODEX_SIDECAR_NODE_CLI;
    if (nodeCli) {
      args.push('--node-cli', nodeCli);
    } else {
      const command = process.env.CAVEAT_CODEX_SIDECAR_COMMAND;
      if (command) args.push('--command', command);
    }

    const result = spawnSync(process.execPath, args, {
      cwd: input.projectRoot,
      encoding: 'utf-8',
      timeout: Number(process.env.CAVEAT_HOOK_CODEX_SIDECAR_TIMEOUT_MS ?? 120_000),
      maxBuffer: 10 * 1024 * 1024,
    });

    if (result.error) {
      advisory = { status: 'failed', message: compactFailureMessage(result.error.message) };
    } else if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
      advisory = {
        status: 'failed',
        message: `sidecar command failed: ${sidecarFailureDetail(detail)}`,
      };
    } else {
      const parsed = JSON.parse(readFileSync(resultFile, 'utf-8')) as {
        status?: string;
        summary?: unknown;
        rawEventLogRef?: unknown;
      };
      if (parsed.status !== 'ok' || typeof parsed.summary !== 'string') {
        advisory = {
          status: 'failed',
          message: compactFailureMessage(`unexpected SidecarResult status: ${String(parsed.status)}`),
        };
      } else {
        advisory = {
          status: 'ok',
          summary: parsed.summary,
          ...(typeof parsed.rawEventLogRef === 'string' ? { rawEventLogRef: parsed.rawEventLogRef } : {}),
        };
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    advisory = {
      status: 'failed',
      message: compactFailureMessage(`invalid SidecarResult JSON: ${msg}`),
    };
  } finally {
    if (resultDir) {
      try {
        rmSync(resultDir, { recursive: true, force: true });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        advisory = {
          status: 'failed',
          message: compactFailureMessage(`sidecar advisory cleanup failed: ${msg}`),
        };
      }
    }
  }
  return advisory;
}

export function formatCodexSidecarAdvisory(advisory: CodexSidecarAdvisory): string {
  if (advisory.status === 'ok') {
    return [
      '[caveat:codex-sidecar] Codex advisory:',
      advisory.summary,
      advisory.rawEventLogRef ? `rawEventLogRef: ${advisory.rawEventLogRef}` : '',
    ].filter(Boolean).join('\n');
  }
  return `[caveat:codex-sidecar] advisory unavailable: ${advisory.message}`;
}
