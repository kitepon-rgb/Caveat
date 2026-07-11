import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  timingSafeEqual,
} from 'node:crypto';

export const SEALED_FORMAT_VERSION = 1;
export const SEALED_MAGIC = 'CVLT';

const SEALED_MAGIC_BYTES = Buffer.from(SEALED_MAGIC, 'ascii');
const HEADER_PREFIX_BYTES = 4 + 1 + 4;
const GCM_TAG_BYTES = 16;
const NONCE_BYTES = 12;
const CONTENT_KEY_BYTES = 32;
const HKDF_SALT = 'caveat-sealed-v1';
const HKDF_INFO_ENC = 'enc';
const HKDF_INFO_NONCE = 'nonce';
const SEALED_ALG = 'aes-256-gcm';

export interface SealedHeader {
  formatVersion: number;
  alg: 'aes-256-gcm';
  keyId: string;
  keyserverUrl: string;
  nonce: string;
  entryCount: number;
}

export type SealedBundleErrorCode =
  | 'BAD_MAGIC'
  | 'UNSUPPORTED_VERSION'
  | 'MALFORMED_HEADER'
  | 'AUTH_FAILED'
  | 'INVALID_RELPATH'
  | 'DUPLICATE_RELPATH'
  | 'ENTRYCOUNT_MISMATCH'
  | 'SEAL_INVARIANT_VIOLATION';

export class SealedBundleError extends Error {
  readonly code: SealedBundleErrorCode;

  constructor(code: SealedBundleErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'SealedBundleError';
  }
}

interface BundleFile {
  relPath: string;
  content: Buffer;
}

interface CanonicalFile extends BundleFile {
  relPathBytes: Buffer;
}

function assertContentKey(contentKey: Buffer): void {
  if (!Buffer.isBuffer(contentKey) || contentKey.length !== CONTENT_KEY_BYTES) {
    throw new SealedBundleError('AUTH_FAILED', 'contentKey must be exactly 32 bytes');
  }
}

// tsconfig の lib は ES2022 で isWellFormed() の型定義を持たないが、本 repo が要求する
// Node 22.5+ はランタイムとして実装済み（tsconfig.base.json の lib 拡張は本修正のスコープ外のため型キャストで吸収）。
function isWellFormedString(value: string): boolean {
  return (value as unknown as { isWellFormed(): boolean }).isWellFormed();
}

function assertRelPath(relPath: string): void {
  if (
    relPath.length === 0 ||
    // Lone surrogates collapse to U+FFFD under Buffer.from(s, 'utf-8'), so two distinct
    // relPath strings could collide on the same relPathBytes and break sort determinism.
    !isWellFormedString(relPath) ||
    /^[A-Za-z]:[\\/]/.test(relPath) ||
    relPath.includes('\\') ||
    // Reject any '' (covers leading/trailing slash and 'a//b'), '.', or '..' segment.
    relPath.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')
  ) {
    throw new SealedBundleError('INVALID_RELPATH', `invalid relPath: ${relPath}`);
  }
}

function canonicalizeFiles(files: BundleFile[]): CanonicalFile[] {
  const seen = new Set<string>();
  const out = files.map((file) => {
    assertRelPath(file.relPath);
    if (seen.has(file.relPath)) {
      throw new SealedBundleError('DUPLICATE_RELPATH', `duplicate relPath: ${file.relPath}`);
    }
    seen.add(file.relPath);
    return { relPath: file.relPath, content: file.content, relPathBytes: Buffer.from(file.relPath, 'utf-8') };
  });
  out.sort((a, b) => Buffer.compare(a.relPathBytes, b.relPathBytes));
  return out;
}

export function buildCanonicalPayload(files: BundleFile[]): Buffer {
  const lines = canonicalizeFiles(files).map((file) => {
    return `{"relPath":${JSON.stringify(file.relPath)},"content":${JSON.stringify(file.content.toString('base64'))}}\n`;
  });
  return Buffer.from(lines.join(''), 'utf-8');
}

function deriveKey(contentKey: Buffer, info: string): Buffer {
  // HKDF separates encryption and nonce-derivation keys under a versioned Caveat domain.
  return Buffer.from(hkdfSync('sha256', contentKey, HKDF_SALT, info, CONTENT_KEY_BYTES));
}

function frame(bytes: Buffer): Buffer {
  // Length-prefixing makes the HMAC input injective: "ab"+"c" cannot equal "a"+"bc".
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([len, bytes]);
}

function deriveNonce(opts: {
  nonceKey: Buffer;
  formatVersion: number;
  keyId: string;
  keyserverUrl: string;
  canonicalPayload: Buffer;
}): Buffer {
  const input = Buffer.concat([
    frame(Buffer.from([opts.formatVersion])),
    frame(Buffer.from(opts.keyId, 'utf-8')),
    frame(Buffer.from(opts.keyserverUrl, 'utf-8')),
    frame(opts.canonicalPayload),
  ]);
  return createHmac('sha256', opts.nonceKey).update(input).digest().subarray(0, NONCE_BYTES);
}

function serializeHeader(header: SealedHeader): Buffer {
  const json =
    `{"formatVersion":${header.formatVersion}` +
    `,"alg":${JSON.stringify(header.alg)}` +
    `,"keyId":${JSON.stringify(header.keyId)}` +
    `,"keyserverUrl":${JSON.stringify(header.keyserverUrl)}` +
    `,"nonce":${JSON.stringify(header.nonce)}` +
    `,"entryCount":${header.entryCount}}`;
  return Buffer.from(json, 'utf-8');
}

function parseHeaderBytes(headerBytes: Buffer): SealedHeader {
  let parsed: unknown;
  try {
    parsed = JSON.parse(headerBytes.toString('utf-8'));
  } catch {
    throw new SealedBundleError('MALFORMED_HEADER', 'sealed bundle header is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new SealedBundleError('MALFORMED_HEADER', 'sealed bundle header must be an object');
  }
  const header = parsed as Partial<SealedHeader>;
  if (
    header.formatVersion !== SEALED_FORMAT_VERSION ||
    header.alg !== SEALED_ALG ||
    typeof header.keyId !== 'string' ||
    typeof header.keyserverUrl !== 'string' ||
    typeof header.nonce !== 'string' ||
    !Number.isInteger(header.entryCount) ||
    (header.entryCount as number) < 0
  ) {
    throw new SealedBundleError('MALFORMED_HEADER', 'sealed bundle header has invalid fields');
  }
  const nonce = Buffer.from(header.nonce, 'base64');
  if (nonce.length !== NONCE_BYTES || nonce.toString('base64') !== header.nonce) {
    throw new SealedBundleError('MALFORMED_HEADER', 'sealed bundle header nonce must be base64-encoded 12 bytes');
  }
  return header as SealedHeader;
}

export function sealBundle(opts: {
  files: BundleFile[];
  contentKey: Buffer;
  keyId: string;
  keyserverUrl: string;
}): Buffer {
  assertContentKey(opts.contentKey);
  const canonicalPayload = buildCanonicalPayload(opts.files);
  const encKey = deriveKey(opts.contentKey, HKDF_INFO_ENC);
  const nonceKey = deriveKey(opts.contentKey, HKDF_INFO_NONCE);
  const nonce = deriveNonce({
    nonceKey,
    formatVersion: SEALED_FORMAT_VERSION,
    keyId: opts.keyId,
    keyserverUrl: opts.keyserverUrl,
    canonicalPayload,
  });
  const header: SealedHeader = {
    formatVersion: SEALED_FORMAT_VERSION,
    alg: SEALED_ALG,
    keyId: opts.keyId,
    keyserverUrl: opts.keyserverUrl,
    nonce: nonce.toString('base64'),
    entryCount: opts.files.length,
  };
  const headerBytes = serializeHeader(header);
  const headerLen = Buffer.alloc(4);
  headerLen.writeUInt32LE(headerBytes.length, 0);

  const cipher = createCipheriv(SEALED_ALG, encKey, nonce);
  cipher.setAAD(headerBytes);
  const ciphertext = Buffer.concat([cipher.update(canonicalPayload), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([
    SEALED_MAGIC_BYTES,
    Buffer.from([SEALED_FORMAT_VERSION]),
    headerLen,
    headerBytes,
    ciphertext,
    tag,
  ]);
}

export function readSealedHeader(bundle: Buffer): {
  header: SealedHeader;
  headerBytes: Buffer;
  payloadOffset: number;
} {
  if (bundle.length < HEADER_PREFIX_BYTES) {
    throw new SealedBundleError('MALFORMED_HEADER', 'sealed bundle is too short');
  }
  if (!bundle.subarray(0, 4).equals(SEALED_MAGIC_BYTES)) {
    throw new SealedBundleError('BAD_MAGIC', 'sealed bundle magic is not CVLT');
  }
  const formatVersion = bundle.readUInt8(4);
  if (formatVersion > SEALED_FORMAT_VERSION) {
    throw new SealedBundleError(
      'UNSUPPORTED_VERSION',
      `unsupported sealed bundle formatVersion ${formatVersion}; caveat をアップグレードせよ`,
    );
  }
  if (formatVersion !== SEALED_FORMAT_VERSION) {
    throw new SealedBundleError('UNSUPPORTED_VERSION', `unsupported sealed bundle formatVersion ${formatVersion}`);
  }
  const headerLen = bundle.readUInt32LE(5);
  const payloadOffset = HEADER_PREFIX_BYTES + headerLen;
  if (headerLen === 0 || payloadOffset > bundle.length || bundle.length - payloadOffset < GCM_TAG_BYTES) {
    throw new SealedBundleError('MALFORMED_HEADER', 'sealed bundle header length is out of bounds');
  }
  const headerBytes = bundle.subarray(HEADER_PREFIX_BYTES, payloadOffset);
  return { header: parseHeaderBytes(headerBytes), headerBytes, payloadOffset };
}

function parsePayload(payload: Buffer, entryCount: number): BundleFile[] {
  if (payload.length === 0) {
    if (entryCount !== 0) {
      throw new SealedBundleError('ENTRYCOUNT_MISMATCH', `header entryCount ${entryCount} does not match 0 payload rows`);
    }
    return [];
  }
  if (payload[payload.length - 1] !== 0x0a) {
    throw new SealedBundleError('MALFORMED_HEADER', 'sealed bundle payload must be newline-terminated JSON Lines');
  }
  const rows = payload.toString('utf-8').split('\n').slice(0, -1);
  if (rows.length !== entryCount) {
    throw new SealedBundleError(
      'ENTRYCOUNT_MISMATCH',
      `header entryCount ${entryCount} does not match ${rows.length} payload rows`,
    );
  }
  const files: BundleFile[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row);
    } catch {
      throw new SealedBundleError('MALFORMED_HEADER', 'sealed bundle payload row is not valid JSON');
    }
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      typeof (parsed as { relPath?: unknown }).relPath !== 'string' ||
      typeof (parsed as { content?: unknown }).content !== 'string'
    ) {
      throw new SealedBundleError('MALFORMED_HEADER', 'sealed bundle payload row has invalid fields');
    }
    const relPath = (parsed as { relPath: string }).relPath;
    assertRelPath(relPath);
    if (seen.has(relPath)) {
      throw new SealedBundleError('DUPLICATE_RELPATH', `duplicate relPath: ${relPath}`);
    }
    seen.add(relPath);
    const content = Buffer.from((parsed as { content: string }).content, 'base64');
    files.push({ relPath, content });
  }
  return files;
}

export function unsealBundle(bundle: Buffer, contentKey: Buffer): {
  header: SealedHeader;
  files: BundleFile[];
} {
  assertContentKey(contentKey);
  const { header, headerBytes, payloadOffset } = readSealedHeader(bundle);
  const encKey = deriveKey(contentKey, HKDF_INFO_ENC);
  const nonceKey = deriveKey(contentKey, HKDF_INFO_NONCE);
  const nonce = Buffer.from(header.nonce, 'base64');
  const ciphertext = bundle.subarray(payloadOffset, bundle.length - GCM_TAG_BYTES);
  const tag = bundle.subarray(bundle.length - GCM_TAG_BYTES);

  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv(SEALED_ALG, encKey, nonce);
    decipher.setAAD(headerBytes);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new SealedBundleError('AUTH_FAILED', 'sealed bundle authentication failed');
  }

  const expectedNonce = deriveNonce({
    nonceKey,
    formatVersion: header.formatVersion,
    keyId: header.keyId,
    keyserverUrl: header.keyserverUrl,
    canonicalPayload: plaintext,
  });
  if (!timingSafeEqual(expectedNonce, nonce)) {
    throw new SealedBundleError(
      'SEAL_INVARIANT_VIOLATION',
      'sealed bundle nonce does not match decrypted canonical payload',
    );
  }

  return { header, files: parsePayload(plaintext, header.entryCount) };
}
