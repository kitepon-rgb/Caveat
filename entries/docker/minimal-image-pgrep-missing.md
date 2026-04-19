---
id: minimal-image-pgrep-missing
title: 'node:slim / alpine 等の最小イメージには pgrep が無い → /proc/1/cmdline を使え'
visibility: public
confidence: confirmed
outcome: resolved
tags: [docker, monitoring, healthcheck, procps]
environment:
  docker: all
  base_image: node:slim / alpine
source_project: null
source_session: "manual/2026-04-19"
created_at: 2026-04-19
updated_at: 2026-04-19
last_verified: 2026-04-19
---

## Context
コンテナ内で「プロセス X が起動しているか」を healthcheck で確認したい。直感的には `pgrep -f 'node server.js'`。

## Symptom
```
sh: pgrep: not found
```
healthcheck 常時失敗。`ps`, `pkill`, `wget` も軒並み無い。

## Cause
- `pgrep` は `procps-ng` package 由来
- `node:slim` (Debian slim) / `alpine` / `distroless` では procps-ng 省略
- 最小イメージは意図的に削っている、個別 `apt-get install procps` で足せるが image size が増える

## Resolution
**`/proc/1/cmdline` を直接読む**（Linux kernel interface、全ての Linux base image で利用可能、追加 package 不要）:

```javascript
// Node.js
const fs = require('node:fs');
const cmdline = fs.readFileSync('/proc/1/cmdline', 'utf8').replace(/\0/g, ' ');
if (cmdline.includes('node server.js')) {
  // alive
}
```

```sh
# shell healthcheck
HEALTHCHECK CMD cat /proc/1/cmdline | tr '\0' ' ' | grep -q 'node server.js' || exit 1
```

**注意**:
- `/proc/1/` は PID 1（コンテナの init）のみ。子プロセスを監視したい場合は `/proc/*/cmdline` を iterate
- Windows コンテナでは動かない（/proc が無い）。Windows target なら別アプローチ
- `\0` セパレータ前提、`\0` → 空白置換してから grep

## Evidence
- ServerManager で `node:20-slim` healthcheck が `pgrep not found` で落ちた
- `/proc/1/cmdline` 版に差し替えて解決、image size も変わらず
