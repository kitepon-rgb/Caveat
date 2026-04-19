---
id: urllib3-debug-leaks-bearer-tokens
title: 'Python logging DEBUG 時に urllib3 のデフォルトロガーが Bearer token を丸ごとログに出す'
visibility: public
confidence: confirmed
outcome: resolved
tags: [python, urllib3, logging, security, token-leak]
environment:
  python: ">=3"
  urllib3: ">=1"
source_project: null
source_session: "manual/2026-04-19"
created_at: 2026-04-19
updated_at: 2026-04-19
last_verified: 2026-04-19
---

## Context
Python アプリ（requests / urllib3 経由で HTTP API を叩く）で DEBUG ログを一時的に有効化してトラブルシュート。

## Symptom
`logging.basicConfig(level=logging.DEBUG)` にすると、urllib3 が以下のような行を吐く:
```
DEBUG urllib3.connectionpool:send:393 GET /v1/dns/update?token=SECRET_TOKEN_XXX HTTP/1.1
DEBUG urllib3.connectionpool:recv:477 "HTTP/1.1 200 OK"
```
**query string 内の token がそのまま記録される**。このログをファイルに出していたり、Sentry/CloudWatch 等に転送していると token がそちらに漏れる。

## Cause
urllib3 は module 自身の logger（`urllib3.connectionpool` 等）を持ち、INFO 以上で通信詳細をログする。アプリ側で自身のコードだけ DEBUG にしたつもりでも、`logging.basicConfig(level=DEBUG)` は root logger を設定するので、urllib3 のロガーも DEBUG になる。URL sanitize は urllib3 側では行わない（責任範囲外）。

## Resolution
アプリ初期化で**明示的に urllib3 のログレベルを上げる**:
```python
import logging
logging.getLogger("urllib3").setLevel(logging.WARNING)
logging.getLogger("urllib3.connectionpool").setLevel(logging.WARNING)
# requests 経由なら requests の内部も urllib3 なので上の 2 行で足りる
```

**先に**やる（HTTP call の前に実行する）。後から setLevel しても、それまでに出たログは取り消せない。

より安全：token は query string ではなく `Authorization: Bearer ...` header で渡す。header は urllib3 が頑張ってマスクしてくれる…**わけではない**（Authorization header も DEBUG では出る）。なので本質的な対策はアプリ側でのログレベル管理。

## Evidence
- DDNSer で DEBUG 有効化中の api call で token が logs/ddns.log に混入していたのを発見
- urllib3 source: `src/urllib3/connectionpool.py` の `_make_request` が raw URL を log
- Python 公式 docs: third-party library のロガーは root level とは独立に設定するのが慣例
