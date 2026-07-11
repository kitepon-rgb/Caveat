import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createKeyserverKeyProvider,
  SealedKeyError,
} from '../src/sealedKeys.js';

interface KeyServer {
  url: string;
  close: () => Promise<void>;
}

let root: string;

function key(byte: number, length = 32): Buffer {
  return Buffer.alloc(length, byte);
}

function expectSealedKeyErrorCode(err: unknown, code: string) {
  expect(err).toBeInstanceOf(SealedKeyError);
  expect((err as SealedKeyError).code).toBe(code);
}

async function startKeyServer(handler: (id: string) => { status?: number; body?: unknown }): Promise<KeyServer> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const prefix = '/v1/keys/';
    if (req.method !== 'GET' || !url.pathname.startsWith(prefix)) {
      res.writeHead(404).end();
      return;
    }
    const id = decodeURIComponent(url.pathname.slice(prefix.length));
    const result = handler(id);
    res.writeHead(result.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result.body ?? { keyId: id, key: key(1).toString('base64') }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('unexpected server address');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'caveat-sealed-keys-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('sealedKeys', () => {
  it('ensures and resolves a key while creating a cache file', async () => {
    const server = await startKeyServer(() => ({ body: { keyId: 'v1', key: key(3).toString('base64') } }));
    try {
      const provider = createKeyserverKeyProvider({ caveatHome: root });
      await provider.ensureKeyAvailable('keyserver:v1', server.url);
      expect(provider.resolveContentKey('keyserver:v1', server.url).equals(key(3))).toBe(true);
      expect(readdirSync(join(root, 'keys')).filter((f) => f.endsWith('.json'))).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it('loads from cache after the server stops', async () => {
    const server = await startKeyServer(() => ({ body: { keyId: 'v1', key: key(4).toString('base64') } }));
    const provider = createKeyserverKeyProvider({ caveatHome: root });
    await provider.ensureKeyAvailable('keyserver:v1', server.url);
    await server.close();

    const cachedProvider = createKeyserverKeyProvider({ caveatHome: root });
    await cachedProvider.ensureKeyAvailable('keyserver:v1', server.url);
    expect(cachedProvider.resolveContentKey('keyserver:v1', server.url).equals(key(4))).toBe(true);
  });

  it('recovers from a corrupt cache by refetching', async () => {
    const server = await startKeyServer(() => ({ body: { keyId: 'v1', key: key(5).toString('base64') } }));
    try {
      const provider = createKeyserverKeyProvider({ caveatHome: root });
      await provider.ensureKeyAvailable('keyserver:v1', server.url);
      const cachePath = join(root, 'keys', readdirSync(join(root, 'keys'))[0]);
      writeFileSync(cachePath, '{bad json', 'utf-8');

      const reloaded = createKeyserverKeyProvider({ caveatHome: root });
      await reloaded.ensureKeyAvailable('keyserver:v1', server.url);
      expect(reloaded.resolveContentKey('keyserver:v1', server.url).equals(key(5))).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('throws KEY_UNAVAILABLE for HTTP 404 or unreachable keyserver without cache', async () => {
    const server = await startKeyServer(() => ({ status: 404, body: { error: 'nope' } }));
    try {
      const provider = createKeyserverKeyProvider({ caveatHome: root });
      await expect(provider.ensureKeyAvailable('keyserver:v1', server.url)).rejects.toThrow(SealedKeyError);
      await provider.ensureKeyAvailable('keyserver:v1', server.url).catch((err) => {
        expectSealedKeyErrorCode(err, 'KEY_UNAVAILABLE');
      });
    } finally {
      await server.close();
    }

    const provider = createKeyserverKeyProvider({ caveatHome: root, timeoutMs: 50 });
    await expect(provider.ensureKeyAvailable('keyserver:v1', 'http://127.0.0.1:9')).rejects.toThrow(SealedKeyError);
    await provider.ensureKeyAvailable('keyserver:v1', 'http://127.0.0.1:9').catch((err) => {
      expectSealedKeyErrorCode(err, 'KEY_UNAVAILABLE');
    });
  });

  it('throws KEY_INVALID for wrong key length or response keyId mismatch', async () => {
    const shortKeyServer = await startKeyServer(() => ({ body: { keyId: 'v1', key: key(6, 31).toString('base64') } }));
    try {
      const provider = createKeyserverKeyProvider({ caveatHome: root });
      await expect(provider.ensureKeyAvailable('keyserver:v1', shortKeyServer.url)).rejects.toThrow(SealedKeyError);
      await provider.ensureKeyAvailable('keyserver:v1', shortKeyServer.url).catch((err) => {
        expectSealedKeyErrorCode(err, 'KEY_INVALID');
      });
    } finally {
      await shortKeyServer.close();
    }

    const mismatchServer = await startKeyServer(() => ({ body: { keyId: 'other', key: key(7).toString('base64') } }));
    try {
      const provider = createKeyserverKeyProvider({ caveatHome: root });
      await expect(provider.ensureKeyAvailable('keyserver:v1', mismatchServer.url)).rejects.toThrow(SealedKeyError);
      await provider.ensureKeyAvailable('keyserver:v1', mismatchServer.url).catch((err) => {
        expectSealedKeyErrorCode(err, 'KEY_INVALID');
      });
    } finally {
      await mismatchServer.close();
    }
  });

  it('keeps identical keyId values from different keyserverUrl values separate', async () => {
    const a = await startKeyServer(() => ({ body: { keyId: 'v1', key: key(8).toString('base64') } }));
    const b = await startKeyServer(() => ({ body: { keyId: 'v1', key: key(9).toString('base64') } }));
    try {
      const provider = createKeyserverKeyProvider({ caveatHome: root });
      await provider.ensureKeyAvailable('keyserver:v1', a.url);
      await provider.ensureKeyAvailable('keyserver:v1', b.url);
      expect(provider.resolveContentKey('keyserver:v1', a.url).equals(key(8))).toBe(true);
      expect(provider.resolveContentKey('keyserver:v1', b.url).equals(key(9))).toBe(true);
      expect(readdirSync(join(root, 'keys')).filter((f) => f.endsWith('.json'))).toHaveLength(2);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('rejects keyserverUrl with a disallowed scheme or non-loopback http', async () => {
    const provider = createKeyserverKeyProvider({ caveatHome: root });
    await expect(provider.ensureKeyAvailable('keyserver:v1', 'data:text/plain,x')).rejects.toThrow(SealedKeyError);
    await provider.ensureKeyAvailable('keyserver:v1', 'data:text/plain,x').catch((err) => {
      expectSealedKeyErrorCode(err, 'KEY_INVALID');
    });

    await expect(provider.ensureKeyAvailable('keyserver:v1', 'http://169.254.169.254')).rejects.toThrow(SealedKeyError);
    await provider.ensureKeyAvailable('keyserver:v1', 'http://169.254.169.254').catch((err) => {
      expectSealedKeyErrorCode(err, 'KEY_INVALID');
    });
  });

  it('returns a defensive copy from resolveContentKey so mutation cannot corrupt the cache', async () => {
    const server = await startKeyServer(() => ({ body: { keyId: 'v1', key: key(11).toString('base64') } }));
    try {
      const provider = createKeyserverKeyProvider({ caveatHome: root });
      await provider.ensureKeyAvailable('keyserver:v1', server.url);
      const first = provider.resolveContentKey('keyserver:v1', server.url);
      first.fill(0);
      const second = provider.resolveContentKey('keyserver:v1', server.url);
      expect(second.equals(key(11))).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('throws when resolveContentKey is called before ensureKeyAvailable', async () => {
    const server = await startKeyServer(() => ({ body: { keyId: 'v1', key: key(10).toString('base64') } }));
    try {
      const provider = createKeyserverKeyProvider({ caveatHome: root });
      expect(existsSync(join(root, 'keys'))).toBe(false);
      expect(() => provider.resolveContentKey('keyserver:v1', server.url)).toThrow(SealedKeyError);
      try {
        provider.resolveContentKey('keyserver:v1', server.url);
      } catch (err) {
        expectSealedKeyErrorCode(err, 'KEY_UNAVAILABLE');
      }
    } finally {
      await server.close();
    }
  });
});
