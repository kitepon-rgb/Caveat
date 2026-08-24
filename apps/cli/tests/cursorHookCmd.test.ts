import { describe, it, expect } from 'vitest';
import { cursorContextOutput } from '../src/commands/cursorHookCmd.js';

describe('cursorContextOutput', () => {
  it('returns Cursor additional_context JSON, not Claude system-reminder', () => {
    const out = cursorContextOutput('hello');
    expect(JSON.parse(out)).toEqual({ additional_context: 'hello' });
    expect(out).not.toContain('system-reminder');
    expect(out).not.toContain('hookSpecificOutput');
  });
});
