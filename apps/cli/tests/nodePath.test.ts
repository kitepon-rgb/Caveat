import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { resolveHookNodePath } from '../src/nodePath.js';

describe('resolveHookNodePath', () => {
  it('prefers a stable PATH node symlink when it resolves to the current Node', () => {
    const stableNode = join('/opt/homebrew/bin', process.platform === 'win32' ? 'node.exe' : 'node');
    const cellarNode = join('/opt/homebrew/Cellar/node/26.0.0/bin', process.platform === 'win32' ? 'node.exe' : 'node');
    const result = resolveHookNodePath({
      env: { PATH: '/opt/homebrew/bin' },
      execPath: cellarNode,
      exists: (path) => path === stableNode,
      realpath: (path) => {
        if (path === stableNode || path === cellarNode) {
          return '/opt/homebrew/Cellar/node/26.0.0/bin/node';
        }
        throw new Error(`unexpected path: ${path}`);
      },
    });

    expect(result).toBe(stableNode);
  });

  it('falls back to execPath when PATH node resolves to a different binary', () => {
    const pathNode = join('/usr/local/bin', process.platform === 'win32' ? 'node.exe' : 'node');
    const execPath = join('/opt/homebrew/Cellar/node/26.0.0/bin', process.platform === 'win32' ? 'node.exe' : 'node');
    const result = resolveHookNodePath({
      env: { PATH: '/usr/local/bin' },
      execPath,
      exists: (path) => path === pathNode,
      realpath: (path) => {
        if (path === pathNode) return '/different/node';
        if (path === execPath) return '/current/node';
        throw new Error(`unexpected path: ${path}`);
      },
    });

    expect(result).toBe(execPath);
  });
});
