import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { generateBrief } from '../src/brief.js';
import { recordEntry } from '../src/record.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('generateBrief', () => {
  it('returns brief_id and formatted text', () => {
    const db = openDb({ path: ':memory:' });
    try {
      const result = generateBrief(db, 'CUDA 12.5 Blackwell');
      expect(result.brief_id).toMatch(/^brf-[a-z0-9]+-[0-9a-f]{8}$/);
      expect(result.text).toContain('調査依頼: CUDA 12.5 Blackwell');
      expect(result.text).toContain(`brief_id: ${result.brief_id}`);
      expect(result.text).toContain('Symptom / Cause / Resolution / Evidence');
    } finally {
      db.close();
    }
  });

  it('includes related existing caveats in text', () => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-brief-'));
    const db = openDb({ path: ':memory:' });
    try {
      recordEntry(
        {
          title: 'CUDA 12.5 required for Blackwell',
          symptom: 'cudaGetDeviceCount returns 0',
          tags: ['gpu', 'cuda'],
        },
        { db, entriesRoot: join(root, 'entries') },
      );
      const result = generateBrief(db, 'CUDA Blackwell');
      expect(result.text).toContain('cuda-12-5-required-for-blackwell');
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
