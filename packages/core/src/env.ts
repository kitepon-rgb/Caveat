import semver from 'semver';
import type { Environment } from './types.js';

export const DEFAULT_SEMVER_KEYS = ['driver', 'cuda', 'node'];
// Intentionally empty. Users set personal workspace roots via ~/.caveatrc.json's
// projectRoots; the default must not ship absolute paths with someone's username.
export const DEFAULT_PROJECT_ROOTS: string[] = [];

export interface Fingerprint extends Environment {
  os: string;
  arch: string;
  node: string;
}

export function fingerprint(): Fingerprint {
  return {
    os: process.platform,
    arch: process.arch,
    node: process.versions.node ?? '',
  };
}

export function envMatch(
  current: Environment,
  required: Environment,
  semverKeys: string[] = DEFAULT_SEMVER_KEYS,
): boolean {
  for (const [key, requiredValue] of Object.entries(required)) {
    const currentValue = current[key];
    if (currentValue === undefined) return false;
    if (semverKeys.includes(key)) {
      if (!matchSemver(currentValue, requiredValue)) return false;
    } else {
      if (!currentValue.toLowerCase().includes(requiredValue.toLowerCase())) return false;
    }
  }
  return true;
}

function matchSemver(current: string, required: string): boolean {
  const m = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(required);
  if (!m) return false;
  const op = m[1] === '=' || !m[1] ? '' : m[1];
  const rhs = m[2]!;

  const head = /^\d+(\.\d+){0,2}/.exec(rhs);
  if (!head) return false;
  const rhsCoerced = semver.coerce(rhs)?.version;
  const headCoerced = semver.coerce(head[0])?.version;
  if (!rhsCoerced || rhsCoerced !== headCoerced) return false;

  const curCoerced = semver.coerce(current)?.version;
  if (!curCoerced) return false;
  const curHead = /^\d+(\.\d+){0,2}/.exec(current);
  if (!curHead || semver.coerce(curHead[0])?.version !== curCoerced) return false;

  return semver.satisfies(curCoerced, `${op}${rhsCoerced}`);
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

export function inferSourceProject(
  cwd: string,
  projectRoots: string[] = DEFAULT_PROJECT_ROOTS,
): string | null {
  const normalized = normalizePath(cwd);
  for (const root of projectRoots) {
    const normalizedRoot = normalizePath(root);
    if (normalized.startsWith(normalizedRoot)) {
      const rest = normalized.slice(normalizedRoot.length);
      const first = rest.split('/')[0];
      if (first) return first;
    }
  }
  return null;
}
