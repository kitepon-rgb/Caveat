import { describe, it, expect } from 'vitest';
import { slugify, resolveCollision, generateSourceSession, randomHex } from '../src/id.js';

describe('slugify', () => {
  it('lowercases and replaces non-alphanumeric with hyphens', () => {
    // CJK chars are stripped as non-alphanumeric, collapsed with surrounding hyphens
    expect(slugify('RTX 5090 で CUDA 失敗')).toBe('rtx-5090-cuda');
  });

  it('collapses multiple hyphens', () => {
    expect(slugify('a---b___c   d')).toBe('a-b-c-d');
  });

  it('trims leading/trailing hyphens', () => {
    expect(slugify('---abc---')).toBe('abc');
  });

  it('falls back to entry-YYYYMMDD-<hex> if result is empty', () => {
    const fixedDate = new Date(Date.UTC(2026, 3, 18));
    const result = slugify('仕様', () => fixedDate);
    expect(result).toMatch(/^entry-20260418-[0-9a-f]{6}$/);
  });

  it('falls back if result does not start with alphanumeric', () => {
    const fixedDate = new Date(Date.UTC(2026, 0, 2));
    const result = slugify('!!!', () => fixedDate);
    expect(result).toMatch(/^entry-20260102-[0-9a-f]{6}$/);
  });
});

describe('resolveCollision', () => {
  it('returns baseId when no collision', () => {
    expect(resolveCollision('foo', () => false)).toBe('foo');
  });

  it('appends -2, -3, ... until unique', () => {
    const taken = new Set(['foo', 'foo-2', 'foo-3']);
    expect(resolveCollision('foo', (id) => taken.has(id))).toBe('foo-4');
  });
});

describe('generateSourceSession', () => {
  it('is <ISO>/<12 hex>', () => {
    const s = generateSourceSession();
    const m = /^(.+?)\/([0-9a-f]{12})$/.exec(s);
    expect(m).not.toBeNull();
    expect(Number.isNaN(Date.parse(m![1]!))).toBe(false);
  });
});

describe('randomHex', () => {
  it('returns exactly N hex chars', () => {
    expect(randomHex(12)).toMatch(/^[0-9a-f]{12}$/);
    expect(randomHex(6)).toMatch(/^[0-9a-f]{6}$/);
    expect(randomHex(1)).toMatch(/^[0-9a-f]{1}$/);
  });
});
