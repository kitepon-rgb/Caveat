import { createHmac, hkdfSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildCanonicalPayload,
  readSealedHeader,
  sealBundle,
  SEALED_FORMAT_VERSION,
  SealedBundleError,
  unsealBundle,
} from '../src/sealedBundle.js';

const contentKey = Buffer.alloc(32, 7);
const wrongKey = Buffer.alloc(32, 8);
const keyId = 'keyserver:v1';
const keyserverUrl = 'http://127.0.0.1:8787';

function sampleFiles() {
  return [
    { relPath: 'zeta.md', content: Buffer.from('last') },
    { relPath: 'alpha/beta.md', content: Buffer.from([0, 1, 2, 255]) },
  ];
}

function expectSealedErrorCode(err: unknown, code: string) {
  expect(err).toBeInstanceOf(SealedBundleError);
  expect((err as SealedBundleError).code).toBe(code);
}

function frame(bytes: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([len, bytes]);
}

function independentNonce(files = sampleFiles()): Buffer {
  const payload = buildCanonicalPayload(files);
  const nonceKey = Buffer.from(hkdfSync('sha256', contentKey, 'caveat-sealed-v1', 'nonce', 32));
  const hmacInput = Buffer.concat([
    frame(Buffer.from([SEALED_FORMAT_VERSION])),
    frame(Buffer.from(keyId, 'utf-8')),
    frame(Buffer.from(keyserverUrl, 'utf-8')),
    frame(payload),
  ]);
  return createHmac('sha256', nonceKey).update(hmacInput).digest().subarray(0, 12);
}

describe('sealedBundle', () => {
  it('roundtrips files byte-for-byte', () => {
    const bundle = sealBundle({ files: sampleFiles(), contentKey, keyId, keyserverUrl });
    const result = unsealBundle(bundle, contentKey);
    expect(result.header.keyId).toBe(keyId);
    expect(result.files).toHaveLength(2);
    expect(result.files.map((f) => f.relPath)).toEqual(['alpha/beta.md', 'zeta.md']);
    expect(result.files[0].content.equals(Buffer.from([0, 1, 2, 255]))).toBe(true);
    expect(result.files[1].content.equals(Buffer.from('last'))).toBe(true);
  });

  it('is deterministic for identical input and shuffled input order', () => {
    const a = sealBundle({ files: sampleFiles(), contentKey, keyId, keyserverUrl });
    const b = sealBundle({ files: sampleFiles(), contentKey, keyId, keyserverUrl });
    const c = sealBundle({ files: [...sampleFiles()].reverse(), contentKey, keyId, keyserverUrl });
    expect(Buffer.compare(a, b)).toBe(0);
    expect(Buffer.compare(a, c)).toBe(0);
  });

  it('matches an independently recomputed deterministic nonce', () => {
    const bundle = sealBundle({ files: sampleFiles(), contentKey, keyId, keyserverUrl });
    const { header } = readSealedHeader(bundle);
    expect(Buffer.from(header.nonce, 'base64').equals(independentNonce())).toBe(true);
  });

  it('throws on ciphertext, AAD, and wrong-key authentication failures', () => {
    const bundle = sealBundle({ files: sampleFiles(), contentKey, keyId, keyserverUrl });
    const { payloadOffset } = readSealedHeader(bundle);
    const ciphertextTampered = Buffer.from(bundle);
    ciphertextTampered[payloadOffset] ^= 0x01;
    expect(() => unsealBundle(ciphertextTampered, contentKey)).toThrow();
    try {
      unsealBundle(ciphertextTampered, contentKey);
    } catch (err) {
      expectSealedErrorCode(err, 'AUTH_FAILED');
    }

    const aadTampered = Buffer.from(bundle);
    const needle = Buffer.from('keyserver:v1');
    const pos = aadTampered.indexOf(needle);
    aadTampered[pos + needle.length - 1] = '2'.charCodeAt(0);
    expect(() => unsealBundle(aadTampered, contentKey)).toThrow();
    try {
      unsealBundle(aadTampered, contentKey);
    } catch (err) {
      expectSealedErrorCode(err, 'AUTH_FAILED');
    }

    expect(() => unsealBundle(bundle, wrongKey)).toThrow();
    try {
      unsealBundle(bundle, wrongKey);
    } catch (err) {
      expectSealedErrorCode(err, 'AUTH_FAILED');
    }
  });

  it('rejects unknown formatVersion with an upgrade message', () => {
    const bundle = sealBundle({ files: sampleFiles(), contentKey, keyId, keyserverUrl });
    const mutated = Buffer.from(bundle);
    mutated[4] = SEALED_FORMAT_VERSION + 1;
    expect(() => readSealedHeader(mutated)).toThrow(/アップグレード/);
    try {
      readSealedHeader(mutated);
    } catch (err) {
      expectSealedErrorCode(err, 'UNSUPPORTED_VERSION');
    }
  });

  it('rejects invalid and duplicate relPaths while sealing', () => {
    for (const relPath of ['../x', '/abs', 'dir\\x', 'a//b.md', './x.md', 'a/.', 'a/']) {
      expect(() => sealBundle({
        files: [{ relPath, content: Buffer.from('x') }],
        contentKey,
        keyId,
        keyserverUrl,
      })).toThrow(SealedBundleError);
    }
    expect(() => sealBundle({
      files: [
        { relPath: 'same.md', content: Buffer.from('a') },
        { relPath: 'same.md', content: Buffer.from('b') },
      ],
      contentKey,
      keyId,
      keyserverUrl,
    })).toThrow(SealedBundleError);
  });

  it('rejects relPath containing a lone surrogate as ill-formed UTF-16', () => {
    expect(() => sealBundle({
      files: [{ relPath: 'a\ud800.md', content: Buffer.from('x') }],
      contentKey,
      keyId,
      keyserverUrl,
    })).toThrow(SealedBundleError);
    try {
      sealBundle({
        files: [{ relPath: 'a\ud800.md', content: Buffer.from('x') }],
        contentKey,
        keyId,
        keyserverUrl,
      });
    } catch (err) {
      expectSealedErrorCode(err, 'INVALID_RELPATH');
    }
  });

  it('fails authentication when the GCM tag is tampered with', () => {
    const bundle = sealBundle({ files: sampleFiles(), contentKey, keyId, keyserverUrl });
    const tagTampered = Buffer.from(bundle);
    tagTampered[tagTampered.length - 1] ^= 0x01;
    expect(() => unsealBundle(tagTampered, contentKey)).toThrow();
    try {
      unsealBundle(tagTampered, contentKey);
    } catch (err) {
      expectSealedErrorCode(err, 'AUTH_FAILED');
    }
  });

  it('roundtrips an empty file list', () => {
    const bundle = sealBundle({ files: [], contentKey, keyId, keyserverUrl });
    const result = unsealBundle(bundle, contentKey);
    expect(result.header.entryCount).toBe(0);
    expect(result.files).toHaveLength(0);
  });

  it('fails authentication when header nonce is replaced with another valid 12B nonce', () => {
    const bundle = sealBundle({ files: sampleFiles(), contentKey, keyId, keyserverUrl });
    const { header } = readSealedHeader(bundle);
    const mutated = Buffer.from(bundle);
    const oldNonce = Buffer.from(header.nonce, 'utf-8');
    const newNonce = Buffer.from(Buffer.alloc(12, 9).toString('base64'), 'utf-8');
    expect(newNonce).toHaveLength(oldNonce.length);
    const pos = mutated.indexOf(oldNonce);
    newNonce.copy(mutated, pos);
    expect(() => unsealBundle(mutated, contentKey)).toThrow();
    try {
      unsealBundle(mutated, contentKey);
    } catch (err) {
      expectSealedErrorCode(err, 'AUTH_FAILED');
    }
  });
});
