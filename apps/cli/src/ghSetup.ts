import { spawnSync } from 'node:child_process';
import { readSync } from 'node:fs';

export interface GhRunResult { status: number | null; stdout: string; stderr: string; }
export type GhRunner = (args: string[]) => GhRunResult;

export function runGh(args: string[]): GhRunResult {
  const result = spawnSync('gh', args, { encoding: 'utf-8' });
  return { status: result.status, stdout: typeof result.stdout === 'string' ? result.stdout : '', stderr: typeof result.stderr === 'string' ? result.stderr : '' };
}

export function commandError(result: GhRunResult, fallback: string): Error {
  return new Error((result.stderr || result.stdout || fallback).trim());
}

export function askOnce(question: string): boolean {
  process.stdout.write(`${question} `);
  const buf = Buffer.alloc(256);
  const bytes = readSync(0, buf, 0, buf.length, null);
  return /^(?:y|yes)$/i.test(buf.toString('utf-8', 0, bytes).trim());
}
