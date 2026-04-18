import { describe, it, expect } from 'vitest';
import { envMatch, inferSourceProject, normalizePath, fingerprint } from '../src/env.js';

describe('envMatch', () => {
  it('matches substring for non-semver keys', () => {
    expect(envMatch({ os: 'windows-11', gpu: 'RTX 5090' }, { os: 'windows' })).toBe(true);
    expect(envMatch({ os: 'linux' }, { os: 'windows' })).toBe(false);
  });

  it('matches semver ranges on whitelisted keys', () => {
    expect(envMatch({ cuda: '12.4' }, { cuda: '<12.5' }, ['cuda'])).toBe(true);
    expect(envMatch({ cuda: '12.6' }, { cuda: '<12.5' }, ['cuda'])).toBe(false);
    expect(envMatch({ cuda: '12.5' }, { cuda: '>=12.5' }, ['cuda'])).toBe(true);
    expect(envMatch({ cuda: '12.5' }, { cuda: '=12.5' }, ['cuda'])).toBe(true);
    expect(envMatch({ cuda: '12.5' }, { cuda: '12.5' }, ['cuda'])).toBe(true);
  });

  it('rejects semver.coerce hallucination for non-semver strings', () => {
    expect(envMatch({ gpu: 'RTX 5090' }, { gpu: 'windows-11' }, ['gpu'])).toBe(false);
  });

  it('rejects when key missing from current', () => {
    expect(envMatch({ os: 'windows-11' }, { gpu: 'RTX 5090' })).toBe(false);
  });

  it('returns true for empty required', () => {
    expect(envMatch({ os: 'windows-11' }, {})).toBe(true);
  });
});

describe('inferSourceProject', () => {
  const roots = ['c:/users/alice/workspace/', '/home/alice/workspace/'];

  it('extracts first segment under project root (windows)', () => {
    expect(
      inferSourceProject('C:\\Users\\alice\\Workspace\\Caveat\\packages\\core', roots),
    ).toBe('caveat');
    expect(inferSourceProject('C:/Users/alice/Workspace/MyTool/src', roots)).toBe('mytool');
  });

  it('extracts first segment under project root (posix)', () => {
    expect(inferSourceProject('/home/alice/workspace/foo/bar', roots)).toBe('foo');
  });

  it('returns null outside project roots', () => {
    expect(inferSourceProject('/tmp/foo', roots)).toBe(null);
    expect(inferSourceProject('D:/Other/Path', roots)).toBe(null);
  });

  it('returns null when default (empty) project roots', () => {
    expect(inferSourceProject('C:/any/path/somewhere')).toBe(null);
  });
});

describe('normalizePath', () => {
  it('lowercases and normalizes separators', () => {
    expect(normalizePath('C:\\Users\\Alice')).toBe('c:/users/alice');
  });
});

describe('fingerprint', () => {
  it('includes os, arch, node', () => {
    const fp = fingerprint();
    expect(typeof fp.os).toBe('string');
    expect(typeof fp.arch).toBe('string');
    expect(fp.node).toMatch(/^\d+\.\d+\.\d+/);
  });
});
