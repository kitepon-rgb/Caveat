---
id: personaplex-libopus-dev-required
title: 'Moshi / PersonaPlex の Linux ビルドには libopus-dev（開発ヘッダ）が必要、runtime だけでは不足'
visibility: public
confidence: confirmed
outcome: resolved
tags: [python, personaplex, moshi, opus, linux]
environment:
  os: linux (debian/ubuntu/fedora)
  package: personaplex / moshi
source_project: null
source_session: "manual/2026-04-19"
created_at: 2026-04-19
updated_at: 2026-04-19
last_verified: 2026-04-19
---

## Context
Linux で PersonaPlex / Moshi の Python パッケージを pip install する。runtime には opus codec が入ってるはず、と思い込む。

## Symptom
```
Building wheels for moshi ...
error: libopus not found
fatal error: opus/opus.h: No such file or directory
```
または import 時に `ImportError: could not load libopus`。

## Cause
Moshi は Rust + Python bindings で opus codec をコンパイル時に link する。**runtime の opus（libopus0 / opus）ではなく development headers（libopus-dev / opus-devel）**が必要。多くのディストリで runtime と dev は別 package で、runtime だけ入れがち。

## Resolution
OS 別にインストール:
```bash
# Debian / Ubuntu
sudo apt install libopus-dev libopus0

# Fedora / RHEL / CentOS
sudo dnf install opus-devel opus

# Arch
sudo pacman -S opus

# macOS (Homebrew)
brew install opus
```

**Windows は vcpkg や conda-forge 経由**。pip install 前に opus を system に入れる順序を守る。

Dockerfile 例:
```dockerfile
RUN apt-get update && apt-get install -y libopus-dev libopus0 && rm -rf /var/lib/apt/lists/*
RUN pip install moshi
```

## Evidence
- personaplex プロジェクトの README で明記
- Moshi source: `Cargo.toml` の `opus-sys = { version = "...", features = [...] }` が opus C ヘッダを要求
