import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir, userInfo } from 'node:os';
import type { PublishFile } from './publish.js';

export type ScanSeverity = 'block' | 'warn';

export interface ScanFinding {
  relPath: string;
  line: number;
  rule:
    | 'aws-key'
    | 'github-pat'
    | 'slack-token'
    | 'pem-private-key'
    | 'high-entropy'
    | 'self-identity'
    | 'path-identity'
    | 'private-ip'
    | 'email';
  severity: ScanSeverity;
  excerpt: string;
  matchDigest: string;
}

export interface PublishScanResult { blocking: ScanFinding[]; warnings: ScanFinding[]; }
export interface PublishScanOptions { selfIdentity: Set<string>; allow?: Set<string>; }

const ALLOW_FILE = '.caveat-publish-allow.json';
const DIGEST_RE = /^[a-f0-9]{64}$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const GENERAL_IDENTITY_PARTS = new Set(['Users', 'users', 'home', 'Home', 'usr', 'var', 'tmp', 'private']);

const BLOCK_RULES: Array<{ rule: ScanFinding['rule']; pattern: RegExp }> = [
  { rule: 'aws-key', pattern: /AKIA[0-9A-Z]{16}/g },
  { rule: 'github-pat', pattern: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { rule: 'github-pat', pattern: /github_pat_[A-Za-z0-9_]{22,}/g },
  { rule: 'slack-token', pattern: /xox[a-zA-Z]-[A-Za-z0-9-]{10,}/g },
  { rule: 'pem-private-key', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g },
];

const HIGH_ENTROPY_RULES: Array<{ pattern: RegExp; entropyFloor: number }> = [
  // 4.3 leaves 2 reviewable benign candidates in the current 166-file corpus,
  // while 4.4 rejects the canonical base64 fixture and every 20-char candidate.
  { pattern: /[A-Za-z0-9+/]{20,}={0,2}/g, entropyFloor: 4.3 },
  { pattern: /[A-Za-z0-9_-]{20,}/g, entropyFloor: 4.3 },
  // Hex has a 4-bit alphabet ceiling. At 32 chars, 3.5 catches about 82% of
  // random values (10k sample); it catches >99% by 48 chars. The current
  // corpus has no 32+-char hex candidate, so this does not add corpus FPs.
  { pattern: /(?<![0-9a-fA-F])[0-9a-fA-F]{32,}(?![0-9a-fA-F])/g, entropyFloor: 3.5 },
];

const POSIX_PATH_RE = /\/[^\s"'`<>()]+(?:\/[^\s"'`<>()]+)+/g;
const WIN_DRIVE_PATH_RE = /\b[A-Za-z]:\\(?:[^\\\s"'`<>()|]+\\){1,}[^\\\s"'`<>()|]+/g;
const WIN_UNC_PATH_RE = /\\\\[^\\\s"'`<>()|]+\\[^\\\s"'`<>()|]+(?:\\[^\\\s"'`<>()|]+)+/g;
const PRIVATE_IP_RE = /\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3})\b/g;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

function sha256(raw: string | Buffer): string {
  return createHash('sha256').update(raw).digest('hex');
}

function findingDigest(opts: {
  rule: ScanFinding['rule'];
  relPath: string;
  raw: string;
  fileDigest: string;
  lineNumber: number;
  index: number;
}): string {
  const pemContext = opts.rule === 'pem-private-key'
    ? `\0${opts.fileDigest}\0${opts.lineNumber}\0${opts.index}`
    : '';
  return sha256(`v1\0${opts.rule}\0${opts.relPath}\0${opts.raw}${pemContext}`);
}

function reset(pattern: RegExp): RegExp {
  pattern.lastIndex = 0;
  return pattern;
}

function maskRaw(raw: string): string {
  if (raw.length <= 8) return '****';
  return `${raw.slice(0, 4)}****${raw.slice(-4)}`;
}

function excerpt(raw: string): string {
  // Never include surrounding line text: a line can contain multiple secrets,
  // and masking only the current match would leak the others in each excerpt.
  return maskRaw(raw);
}

function addFinding(
  out: ScanFinding[],
  seen: Set<string>,
  opts: {
    relPath: string;
    lineNumber: number;
    raw: string;
    index: number;
    rule: ScanFinding['rule'];
    severity: ScanSeverity;
    fileDigest: string;
  },
): void {
  const key = `${opts.relPath}\0${opts.lineNumber}\0${opts.raw}`;
  if (seen.has(key)) return;
  seen.add(key);
  const matchDigest = findingDigest(opts);
  out.push({
    relPath: opts.relPath,
    line: opts.lineNumber,
    rule: opts.rule,
    severity: opts.severity,
    excerpt: excerpt(opts.raw),
    matchDigest,
  });
}

function isAsciiLetter(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z]/.test(value);
}

function selfIdentityMatches(line: string, selfIdentity: Set<string>): Array<{ raw: string; index: number }> {
  const matches: Array<{ raw: string; index: number }> = [];
  for (const token of selfIdentity) {
    if (token.length < 3) continue;
    let from = 0;
    while (from <= line.length - token.length) {
      const index = line.indexOf(token, from);
      if (index < 0) break;
      const before = line[index - 1];
      const after = line[index + token.length];
      if (!isAsciiLetter(before) && !isAsciiLetter(after)) matches.push({ raw: token, index });
      from = index + Math.max(1, token.length);
    }
  }
  return matches;
}

interface MatchSpan { start: number; end: number; }

function addRegexMatches(
  findings: ScanFinding[],
  seen: Set<string>,
  opts: {
    relPath: string;
    lineNumber: number;
    line: string;
    pattern: RegExp;
    rule: ScanFinding['rule'];
    severity: ScanSeverity;
    fileDigest: string;
  },
): MatchSpan[] {
  const spans: MatchSpan[] = [];
  for (const match of opts.line.matchAll(reset(opts.pattern))) {
    const raw = match[0];
    if (!raw) continue;
    const index = match.index ?? 0;
    spans.push({ start: index, end: index + raw.length });
    addFinding(findings, seen, {
      relPath: opts.relPath,
      lineNumber: opts.lineNumber,
      raw,
      index,
      rule: opts.rule,
      severity: opts.severity,
      fileDigest: opts.fileDigest,
    });
  }
  return spans;
}

function shannonEntropy(raw: string): number {
  const value = raw.replace(/=+$/, '');
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

interface EntropyCandidate extends MatchSpan { raw: string; }

function highEntropyCandidates(line: string, knownSecretSpans: MatchSpan[]): EntropyCandidate[] {
  const candidates: EntropyCandidate[] = [];
  for (const rule of HIGH_ENTROPY_RULES) {
    for (const match of line.matchAll(reset(rule.pattern))) {
      const raw = match[0];
      if (!raw || UUID_RE.test(raw) || shannonEntropy(raw) < rule.entropyFloor) continue;
      const start = match.index ?? 0;
      const candidate = { raw, start, end: start + raw.length };
      const containedByKnownSecret = knownSecretSpans.some(
        (span) => span.start <= candidate.start && span.end >= candidate.end,
      );
      if (!containedByKnownSecret) candidates.push(candidate);
    }
  }

  candidates.sort((left, right) => left.start - right.start || right.end - left.end);
  const normalized: EntropyCandidate[] = [];
  for (const candidate of candidates) {
    // Sorting puts a containing candidate before candidates it contains. Keep
    // crossing overlaps separate: unioning them would invent a mixed charset.
    if (normalized.some((existing) => existing.start <= candidate.start && existing.end >= candidate.end)) continue;
    normalized.push(candidate);
  }
  return normalized;
}

export function scanPublishFiles(files: PublishFile[], opts: PublishScanOptions): PublishScanResult {
  const blocking: ScanFinding[] = [];
  const warnings: ScanFinding[] = [];
  const seen = new Set<string>();
  const allow = opts.allow ?? new Set<string>();

  for (const file of files) {
    const fileDigest = sha256(file.content);
    const lines = file.content.toString('utf-8').split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const lineNumber = index + 1;
      const knownSecretSpans: MatchSpan[] = [];
      for (const rule of BLOCK_RULES) {
        knownSecretSpans.push(...addRegexMatches(blocking, seen, {
          relPath: file.relPath,
          lineNumber,
          line,
          pattern: rule.pattern,
          rule: rule.rule,
          severity: 'block',
          fileDigest,
        }));
      }
      for (const candidate of highEntropyCandidates(line, knownSecretSpans)) {
        addFinding(blocking, seen, {
          relPath: file.relPath,
          lineNumber: lineNumber,
          raw: candidate.raw,
          index: candidate.start,
          rule: 'high-entropy',
          severity: 'block',
          fileDigest,
        });
      }
      const identityMatches = selfIdentityMatches(line, opts.selfIdentity);
      if (identityMatches.length > 0) {
        for (const match of identityMatches) {
          addFinding(blocking, seen, {
            relPath: file.relPath,
            lineNumber,
            raw: match.raw,
            index: match.index,
            rule: 'self-identity',
            severity: 'block',
            fileDigest,
          });
        }
        for (const pattern of [POSIX_PATH_RE, WIN_DRIVE_PATH_RE, WIN_UNC_PATH_RE]) {
          addRegexMatches(blocking, seen, {
            relPath: file.relPath,
            lineNumber,
            line,
            pattern,
            rule: 'path-identity',
            severity: 'block',
            fileDigest,
          });
        }
      }
      addRegexMatches(warnings, seen, {
        relPath: file.relPath,
        lineNumber,
        line,
        pattern: PRIVATE_IP_RE,
        rule: 'private-ip',
        severity: 'warn',
        fileDigest,
      });
      addRegexMatches(warnings, seen, {
        relPath: file.relPath,
        lineNumber,
        line,
        pattern: EMAIL_RE,
        rule: 'email',
        severity: 'warn',
        fileDigest,
      });
    }
  }

  return { blocking: blocking.filter((finding) => !allow.has(finding.matchDigest)), warnings };
}

export function publishSelfIdentityTokens(): Set<string> {
  const out = new Set<string>();
  const add = (token: string | undefined): void => {
    if (!token || token.length < 3 || GENERAL_IDENTITY_PARTS.has(token)) return;
    out.add(token);
  };
  try {
    add(userInfo().username);
  } catch {
    // userInfo() can throw in constrained environments.
  }
  try {
    add(basename(homedir()));
  } catch {
    // homedir() can throw if the environment has no home directory.
  }
  return out;
}

export function loadPublishAllow(knowledgeRepo: string): Set<string> {
  const path = join(knowledgeRepo, ALLOW_FILE);
  if (!existsSync(path)) return new Set<string>();
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { allow?: unknown };
  if (!Array.isArray(parsed.allow)) throw new Error(`${ALLOW_FILE} must contain an "allow" array`);
  return new Set(parsed.allow.filter((value): value is string => typeof value === 'string' && DIGEST_RE.test(value)));
}

export function savePublishAllow(knowledgeRepo: string, digests: string[]): void {
  const existing = loadPublishAllow(knowledgeRepo);
  for (const digestValue of digests) {
    if (DIGEST_RE.test(digestValue)) existing.add(digestValue);
  }
  const allow = [...existing].sort();
  writeFileSync(join(knowledgeRepo, ALLOW_FILE), `${JSON.stringify({ allow }, null, 2)}\n`, 'utf-8');
}

export class PublishScanError extends Error {
  readonly findings: ScanFinding[];

  constructor(findings: ScanFinding[]) {
    super([
      'publish scan blocked public entry publishing:',
      ...findings.map((finding) => `${finding.relPath}:${finding.line} ${finding.rule} ${finding.excerpt}`),
      'Allow a finding for this publish only with:',
      ...findings.map((finding) => `--allow ${finding.matchDigest}`),
    ].join('\n'));
    this.name = 'PublishScanError';
    this.findings = findings;
  }
}
