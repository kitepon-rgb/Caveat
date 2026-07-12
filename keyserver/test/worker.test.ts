import { describe, expect, it } from 'vitest';
import { handleKeyRequest } from '../src/worker.js';

/**
 * env.KEYS のモック。実 KVNamespace の全メソッドは持たず、handleKeyRequest が
 * 実際に呼ぶ `.get` だけを実装する（handleKeyRequest の env 引数は KVNamespace 型だが、
 * このファイルはユニットテストなので構造的に必要な分だけ満たして cast する）。
 */
function makeKvMock(map: Record<string, string>) {
  return {
    get: async (key: string) => (Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null),
  } as unknown as import('@cloudflare/workers-types').KVNamespace;
}

/**
 * packages/core/src/sealedKeys.ts の decodeBase64Key（L90-99）と同じ正規表現・長さ計算で
 * base64 デコード後のバイト長を求める。Worker は Node ではなく Workers ランタイムで動くため、
 * このテストファイルは Node 専用 API（Buffer 等）に依存させず、クライアント側の検証と
 * 同じロジックを純粋な文字列演算で再現する。
 */
function base64DecodedByteLength(value: string): number {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`not valid base64: ${value}`);
  }
  const paddingMatch = /=+$/.exec(value);
  const padding = paddingMatch ? paddingMatch[0].length : 0;
  return (value.length / 4) * 3 - padding;
}

// KV に格納されている想定の base64 32B 鍵（テスト用ダミー値、実鍵ではない）。
// 32 バイト全て 0x07 を base64 エンコードしたもの。
const VALID_BASE64_32B_KEY = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=';

function makeRequest(path: string, method = 'GET'): Request {
  return new Request(`https://keyserver.example.com${path}`, { method });
}

describe('handleKeyRequest', () => {
  it('正常: 既知 id は 200 + {keyId, key} を返し、key は base64 32B としてデコードできる', async () => {
    const env = { KEYS: makeKvMock({ v1: VALID_BASE64_32B_KEY }) };
    const res = await handleKeyRequest(makeRequest('/v1/keys/v1'), env);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');

    const body = (await res.json()) as { keyId: string; key: string };

    // packages/core/src/sealedKeys.ts の fetchKey（L157-164）はここを検証する:
    // parsed.keyId !== bareId なら KEY_INVALID。ここでは要求 id ('v1') と厳密一致することを確認する。
    expect(body.keyId).toBe('v1');

    // decodeBase64Key（sealedKeys.ts L90-99）は base64 デコード後ちょうど 32 バイトであることを要求する。
    expect(base64DecodedByteLength(body.key)).toBe(32);
    expect(body.key).toBe(VALID_BASE64_32B_KEY);
  });

  it('未知 id は 404 を返す', async () => {
    const env = { KEYS: makeKvMock({}) };
    const res = await handleKeyRequest(makeRequest('/v1/keys/does-not-exist'), env);
    expect(res.status).toBe(404);
  });

  it('GET 以外（POST）は 405 を返す', async () => {
    const env = { KEYS: makeKvMock({ v1: VALID_BASE64_32B_KEY }) };
    const res = await handleKeyRequest(makeRequest('/v1/keys/v1', 'POST'), env);
    expect(res.status).toBe(405);
  });

  describe('パストラバーサル・多段パスは KV get に到達せず 400 or 404 になる', () => {
    it('/v1/keys/../secret は URL 正規化で /v1/keys 配下から外れ 404', async () => {
      let kvCalled = false;
      const env = {
        KEYS: {
          get: async () => {
            kvCalled = true;
            return null;
          },
        } as unknown as import('@cloudflare/workers-types').KVNamespace,
      };
      const res = await handleKeyRequest(makeRequest('/v1/keys/../secret'), env);
      expect([400, 404]).toContain(res.status);
      expect(kvCalled).toBe(false);
    });

    it('/v1/keys/a/b は多段パスとして 404', async () => {
      let kvCalled = false;
      const env = {
        KEYS: {
          get: async () => {
            kvCalled = true;
            return null;
          },
        } as unknown as import('@cloudflare/workers-types').KVNamespace,
      };
      const res = await handleKeyRequest(makeRequest('/v1/keys/a/b'), env);
      expect([400, 404]).toContain(res.status);
      expect(kvCalled).toBe(false);
    });

    it('percent-encoded ../ (%2e%2e%2f) はデコード後の "..","/" 検査で 400', async () => {
      let kvCalled = false;
      const env = {
        KEYS: {
          get: async () => {
            kvCalled = true;
            return null;
          },
        } as unknown as import('@cloudflare/workers-types').KVNamespace,
      };
      const res = await handleKeyRequest(makeRequest('/v1/keys/%2e%2e%2fsecret'), env);
      expect([400, 404]).toContain(res.status);
      expect(kvCalled).toBe(false);
    });

    it('末尾スラッシュ /v1/keys/abc/ は 404', async () => {
      const env = { KEYS: makeKvMock({ abc: VALID_BASE64_32B_KEY }) };
      const res = await handleKeyRequest(makeRequest('/v1/keys/abc/'), env);
      expect([400, 404]).toContain(res.status);
    });

    it('過度に長い id（128 文字超）は 400', async () => {
      const longId = 'a'.repeat(129);
      const env = { KEYS: makeKvMock({ [longId]: VALID_BASE64_32B_KEY }) };
      const res = await handleKeyRequest(makeRequest(`/v1/keys/${longId}`), env);
      expect(res.status).toBe(400);
    });
  });

  describe('契約往復: client の encodeURIComponent(bareId) を Worker が同一 bareId へ復元する', () => {
    // sealedKeys.ts fetchKey（L141）は `${keyserverUrl}/v1/keys/${encodeURIComponent(bareId)}` で要求する。
    // Worker が decodeURIComponent 後の bareId を KV 参照キーとレスポンス keyId の両方に使うことを、
    // 空白・記号・非 ASCII・内部ドットといった非自明な文字で確認する（refuter 指摘のカバレッジ欠落を封鎖）。
    const TRICKY_IDS = ['v1.2', 'prod.key.1', 'a b', 'a+b', 'a%b', 'café', '2026-07', 'キー'];
    for (const bareId of TRICKY_IDS) {
      it(`bareId="${bareId}" は往復して keyId 厳密一致 + 正しい KV キーで get される`, async () => {
        const requestedKeys: string[] = [];
        const env = {
          KEYS: {
            get: async (key: string) => {
              requestedKeys.push(key);
              return key === bareId ? VALID_BASE64_32B_KEY : null;
            },
          } as unknown as import('@cloudflare/workers-types').KVNamespace,
        };
        // client と同一の URL 構築（encodeURIComponent）で叩く。
        const res = await handleKeyRequest(makeRequest(`/v1/keys/${encodeURIComponent(bareId)}`), env);
        expect(res.status).toBe(200);
        // KV は decode 後の bareId ちょうどで引かれている（別文字列なら null=404 になっていたはず）。
        expect(requestedKeys).toEqual([bareId]);
        const body = (await res.json()) as { keyId: string; key: string };
        // sealedKeys.ts L160: parsed.keyId !== bareId なら KEY_INVALID。厳密一致を要求する。
        expect(body.keyId).toBe(bareId);
        expect(base64DecodedByteLength(body.key)).toBe(32);
      });
    }
  });

  it('/other/path は 404', async () => {
    const env = { KEYS: makeKvMock({}) };
    const res = await handleKeyRequest(makeRequest('/other/path'), env);
    expect(res.status).toBe(404);
  });

  it('契約回帰: レスポンス JSON のキーは厳密に keyId と key のみ', async () => {
    const env = { KEYS: makeKvMock({ v1: VALID_BASE64_32B_KEY }) };
    const res = await handleKeyRequest(makeRequest('/v1/keys/v1'), env);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['key', 'keyId']);
  });
});
