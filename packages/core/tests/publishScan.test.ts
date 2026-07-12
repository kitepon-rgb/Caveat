import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PublishFile } from '../src/publish.js';
import {
  loadPublishAllow,
  PublishScanError,
  savePublishAllow,
  scanPublishFiles,
} from '../src/publishScan.js';

function file(content: string, relPath = 'entry.md'): PublishFile {
  return { relPath, content: Buffer.from(content, 'utf-8'), showcase: false };
}

function scan(content: string, selfIdentity = new Set<string>()): ReturnType<typeof scanPublishFiles> {
  return scanPublishFiles([file(content)], { selfIdentity });
}

describe('scanPublishFiles', () => {
  it('blocks the canonical high-confidence known-secret subset', () => {
    const result = scan([
      'aws AKIAABCDEFGHIJKLMNOP',
      'github ghp_0123456789abcdefghijklmnopqrstuvwxyz',
      'github fine github_pat_0123456789abcdefghijkl_ABCDEFGHI',
      'slack xoxb-0123456789abcdef',
      'pem -----BEGIN OPENSSH PRIVATE KEY-----',
    ].join('\n'));
    expect(result.blocking.map((f) => f.rule)).toEqual([
      'aws-key',
      'github-pat',
      'github-pat',
      'slack-token',
      'pem-private-key',
    ]);
  });

  it('keeps a high-entropy candidate that extends beyond an overlapping known secret', () => {
    const raw = 'AbCdEfGhIjKlMnOpQrStAKIAABCDEFGHIJKLMNOPUvWxYz0123456789';
    const first = scan(raw);
    expect(first.blocking.map((finding) => finding.rule)).toEqual(['aws-key', 'high-entropy']);
    const awsAllow = new Set([first.blocking.find((finding) => finding.rule === 'aws-key')!.matchDigest]);
    const second = scanPublishFiles([file(raw)], { selfIdentity: new Set(), allow: awsAllow });
    expect(second.blocking.map((finding) => finding.rule)).toEqual(['high-entropy']);
  });

  it('routes high-entropy provider shapes through the generic rule without adding key=value heuristics', () => {
    const result = scan([
      'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456',
      'google AIzaSyabcdefghijklmnopqrstuvwxyz123456',
      'jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature',
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456',
      'API_KEY=somevalue',
    ].join('\n'));
    expect(result.blocking.map((finding) => `${finding.line}:${finding.rule}`)).toEqual([
      '1:high-entropy',
      '2:high-entropy',
      '3:high-entropy',
      '4:high-entropy',
    ]);
  });

  it('blocks strict base64 and url-safe candidates but excludes UUIDs and short strings', () => {
    const result = scan([
      'std QWxhZGRpbjpvcGVuIHNlc2FtZQ==',
      'url abcdefghijklmnopQRST_123-456',
      'uuid 123e4567-e89b-12d3-a456-426614174000',
      'short abcdefghijklmnopqrs',
    ].join('\n'));
    expect(result.blocking.map((f) => f.excerpt).join('\n')).toContain('QWxh');
    expect(result.blocking.map((f) => f.excerpt).join('\n')).toContain('abcd');
    expect(result.blocking).toHaveLength(2);
  });

  it('detects high-entropy hex separately while rejecting a low-entropy repeated value', () => {
    const result = scan([
      'hex 8f3a9c7e2b1d4f6a0c5e8b7d3a9f2c1e',
      `repeated ${'ab'.repeat(32)}`,
    ].join('\n'));
    expect(result.blocking.map((finding) => `${finding.line}:${finding.rule}`)).toEqual(['1:high-entropy']);
  });

  it('keeps crossing strict-charset candidates separate instead of unioning them', () => {
    const result = scan('AbCdEfGhIjKlMnOpQrSt+UvWxYz0123456789_abcdefghIJKL');
    expect(result.blocking.map((finding) => finding.rule)).toEqual(['high-entropy', 'high-entropy']);
  });

  it('blocks case-sensitive self identity at ASCII letter boundaries only', () => {
    const result = scan([
      'ssh kite@server',
      'ssh Kite@server',
      'github.com/kitepon-rgb/repo',
      'prefix akite suffix',
      'win kite_\\AppData',
      'path /home/kite/project',
      'owner kite',
    ].join('\n'), new Set(['kite']));
    expect(result.blocking.map((finding) => `${finding.line}:${finding.rule}`)).toEqual([
      '1:self-identity',
      '5:self-identity',
      '6:self-identity',
      '6:path-identity',
      '7:self-identity',
    ]);
  });

  it('blocks absolute paths only on lines that also contain self identity', () => {
    const result = scan([
      'leak /home/kite/project',
      'command /usr/bin/git status',
      'win C:\\Users\\kite_\\AppData',
      'different /home/kite/project',
    ].join('\n'), new Set(['kite_']));
    expect(result.blocking.map((f) => `${f.line}:${f.rule}`)).toEqual([
      '3:self-identity',
      '3:path-identity',
    ]);
  });

  it('reports private IPs and email-shaped values as warnings only', () => {
    const result = scan('connect 192.168.1.10:443\nremote git@github.com');
    expect(result.blocking).toEqual([]);
    expect(result.warnings.map((f) => f.rule)).toEqual(['private-ip', 'email']);
  });

  it('suppresses an allowed finding without allowing the same raw value in another path', () => {
    const first = scan('aws AKIAABCDEFGHIJKLMNOP');
    const allow = new Set([first.blocking[0].matchDigest]);
    const second = scanPublishFiles([
      file('aws AKIAABCDEFGHIJKLMNOP'),
      file('aws AKIAABCDEFGHIJKLMNOP', 'other.md'),
    ], { selfIdentity: new Set(), allow });
    expect(second.blocking).toHaveLength(1);
    expect(second.blocking[0].relPath).toBe('other.md');
  });

  it('binds a PEM allow digest to the file content instead of its fixed header', () => {
    const first = scan('-----BEGIN OPENSSH PRIVATE KEY-----\nfirst\n-----END OPENSSH PRIVATE KEY-----');
    const second = scan('-----BEGIN OPENSSH PRIVATE KEY-----\nsecond\n-----END OPENSSH PRIVATE KEY-----');
    expect(first.blocking[0].rule).toBe('pem-private-key');
    expect(second.blocking[0].rule).toBe('pem-private-key');
    expect(first.blocking[0].matchDigest).not.toBe(second.blocking[0].matchDigest);
  });

  it('gives multiple PEM headers in one file distinct allow digests', () => {
    const content = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'first',
      '-----END OPENSSH PRIVATE KEY-----',
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'second',
      '-----END OPENSSH PRIVATE KEY-----',
    ].join('\n');
    const first = scan(content);
    expect(first.blocking.map((finding) => finding.rule)).toEqual(['pem-private-key', 'pem-private-key']);
    expect(new Set(first.blocking.map((finding) => finding.matchDigest)).size).toBe(2);
    const second = scanPublishFiles([file(content)], {
      selfIdentity: new Set(),
      allow: new Set([first.blocking[0].matchDigest]),
    });
    expect(second.blocking).toHaveLength(1);
  });

  it('masks excerpts and keeps the raw match out of error text', () => {
    const raw = 'AKIAABCDEFGHIJKLMNOP';
    const result = scan(`aws ${raw}`);
    expect(result.blocking[0].excerpt).not.toContain(raw);
    expect(new PublishScanError(result.blocking).message).not.toContain(raw);
    expect(result.blocking[0].matchDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('does not leak another secret from the same line in an excerpt', () => {
    const aws = 'AKIAABCDEFGHIJKLMNOP';
    const github = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';
    const result = scan(`${aws} ${github}`);
    for (const finding of result.blocking) {
      expect(finding.excerpt).not.toContain(aws);
      expect(finding.excerpt).not.toContain(github);
    }
    const message = new PublishScanError(result.blocking).message;
    expect(message).not.toContain(aws);
    expect(message).not.toContain(github);
  });
});

describe('publish allow file', () => {
  it('loads and saves sorted digest allowlists in the own repo', () => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-publish-allow-'));
    try {
      const a = 'b'.repeat(64);
      const b = 'a'.repeat(64);
      savePublishAllow(root, [a, b, a]);
      expect([...loadPublishAllow(root)]).toEqual([b, a]);
      expect(JSON.parse(readFileSync(join(root, '.caveat-publish-allow.json'), 'utf-8'))).toEqual({ allow: [b, a] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
