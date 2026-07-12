/**
 * keyserver-lite — Cloudflare Worker
 *
 * docs/07 Track B の実装。クライアント契約は
 * packages/core/src/sealedKeys.ts の `fetchKey`（同ファイル L137-165）に厳密に従う:
 *
 *   - リクエスト: GET <keyserverUrl>/v1/keys/<encodeURIComponent(bareId)>
 *   - レスポンス: response.ok（2xx）かつ JSON `{ "keyId": "<bareId>", "key": "<base64>" }`
 *     - keyId は要求 bareId と厳密一致（`!==` 比較）していること
 *     - key は base64 デコードして正確に 32 バイトであること
 *
 * この形式を 1 バイトでも外すと全購読者が復号不能になる（契約クリティカル）。
 * KV には既に base64 32B の鍵文字列がそのまま格納されている前提で、
 * このファイルはそれを右から左へ橋渡しするだけに留める。
 */

import type { KVNamespace } from '@cloudflare/workers-types';

const KEY_PATH_PATTERN = /^\/v1\/keys\/([^/]+)$/;
const MAX_ID_LENGTH = 128;

export interface KeyserverEnv {
  KEYS: KVNamespace;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * リクエストの id 部分を検証する。パストラバーサル・濫用防止のため、
 * KV への get 呼び出しより前に必ず弾く。
 */
function isValidId(id: string): boolean {
  if (id.length === 0) return false;
  if (id.length > MAX_ID_LENGTH) return false;
  if (id.includes('/')) return false;
  if (id.includes('\\')) return false;
  if (id.includes('..')) return false;
  return true;
}

export async function handleKeyRequest(
  request: Request,
  env: { KEYS: KVNamespace }
): Promise<Response> {
  if (request.method !== 'GET') {
    return jsonResponse({ error: 'method not allowed' }, 405);
  }

  const url = new URL(request.url);
  const match = KEY_PATH_PATTERN.exec(url.pathname);
  const rawId = match?.[1];
  if (rawId === undefined) {
    return jsonResponse({ error: 'not found' }, 404);
  }

  let id: string;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    return jsonResponse({ error: 'malformed id' }, 400);
  }

  if (!isValidId(id)) {
    return jsonResponse({ error: 'invalid id' }, 400);
  }

  const key = await env.KEYS.get(id);
  if (key === null) {
    return jsonResponse({ error: 'not found' }, 404);
  }

  // クライアント（sealedKeys.ts fetchKey）は keyId が要求 bareId と厳密一致することと、
  // key が base64 デコードして正確に 32 バイトであることを検証する。
  // レスポンスはこの 2 フィールドのみを返し、余計なフィールドは足さない。
  return jsonResponse({ keyId: id, key }, 200);
}

export default {
  fetch: (request: Request, env: KeyserverEnv): Promise<Response> => handleKeyRequest(request, env),
};
