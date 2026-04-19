---
id: express-trust-proxy-rate-limit
title: 'Express の app.set(''trust proxy'', true) は express-rate-limit とぶつかり ERR_ERL_PERMISSIVE_TRUST_PROXY'
visibility: public
confidence: confirmed
outcome: resolved
tags: [express, nodejs, rate-limit, proxy]
environment:
  express: ">=4.18"
  express-rate-limit: ">=7"
  node: ">=18"
source_project: null
source_session: "manual/2026-04-19"
created_at: 2026-04-19
updated_at: 2026-04-19
last_verified: 2026-04-19
---

## Context
Caddy / nginx 等の reverse proxy 配下で Express を動かすとき、client IP を X-Forwarded-For から取るために `app.set('trust proxy', true)` を書きがち。

## Symptom
`express-rate-limit` が起動時 or 初回リクエストで:
```
Error: ERR_ERL_PERMISSIVE_TRUST_PROXY
The rate limiter is using a trust proxy setting that is permissive (true),
which may make IP-based rate limiting ineffective.
```
を投げて死ぬ。rate limiter が動かない（または crash）。

## Cause
express-rate-limit v7 以降は trust proxy の値を厳密に検証する。`true` は「全 proxy を信頼」= 攻撃者が任意 X-Forwarded-For を挿入してレート制限を回避できる、という危険設定として reject する。Caddy 1 段しか経由しないシンプル構成でも、**true は常に過剰**。

## Resolution
```javascript
// シングル reverse proxy（Caddy 1 段など）の場合:
app.set('trust proxy', 1)        // ← true ではなく 1（数値）

// 複数層（Cloudflare + Caddy 等）:
app.set('trust proxy', 2)        // 信頼する hop 数

// 厳密にしたいなら proxy の IP 指定:
app.set('trust proxy', '127.0.0.1, 192.168.1.1')
```

`1` でも警告が出るなら `loopback` など named alias も使える。**`true` は開発中テスト以外で使わない**。

## Evidence
- express-rate-limit v7 の issue / ドキュメント: https://express-rate-limit.mintlify.app/guides/troubleshooting-proxy-issues
- ConnectC2X で Caddy 配下で遭遇、`1` への変更で即解決
