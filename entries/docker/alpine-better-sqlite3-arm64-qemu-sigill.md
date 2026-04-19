---
id: alpine-better-sqlite3-arm64-qemu-sigill
title: 'Alpine base + better-sqlite3 + buildx linux/arm64 (QEMU) は SIGILL で不定期 crash'
visibility: public
confidence: confirmed
outcome: resolved
tags: [docker, alpine, better-sqlite3, arm64, qemu, native-module]
environment:
  docker: buildx
  target_arch: arm64
  base_image: alpine
  native_module: better-sqlite3
source_project: null
source_session: "manual/2026-04-19"
created_at: 2026-04-19
updated_at: 2026-04-19
last_verified: 2026-04-19
---

## Context
GitHub Actions buildx で multi-arch image を作成（`linux/amd64,linux/arm64`）。amd64 ホスト上で arm64 ビルドは QEMU user-mode エミュレーションで実行される。

## Symptom
buildx は成功し image も push されるが、arm64 image を実機（Raspberry Pi / AWS Graviton / Apple Silicon 等）で `docker run` すると:
```
Illegal instruction (core dumped)
```
amd64 image は問題なし。crash は非決定的で、特定の better-sqlite3 クエリパスで出やすい。

## Cause
QEMU user-mode emulation は ARM64 CPU の一部拡張命令（NEON 等）を完全にエミュレートしない。better-sqlite3 は native binding で C コードから SQLite を叩き、コンパイラ（Alpine の musl + gcc）が ARM64 拡張命令を生成する可能性がある。Alpine の musl libc と QEMU の組み合わせで、この生成命令が QEMU に食わせるとき illegal 扱いになる。

## Resolution
- **base image を `node:20-slim`（Debian）に変更**。Debian の glibc は QEMU との相性が良く、native binding のコンパイル結果も安定
- Alpine + better-sqlite3 + cross-arch の組み合わせは**原理的に不安定**（musl + QEMU 拡張命令）なので避ける
- HTTPS git clone をコンテナ内でやるなら `apt-get install -y ca-certificates` を明示
- 実機クロスビルド（QEMU なし、実 ARM64 runner）なら Alpine でも動くはず、が実機 runner のコストを考えると Debian のほうが楽

## Evidence
- LicenseServer で Alpine build → arm64 ランタイム SIGILL を 3 回再現
- Debian slim に差し替えた直後から 0 件
- 類似事例: https://github.com/WiseLibs/better-sqlite3/issues?q=qemu+arm64
