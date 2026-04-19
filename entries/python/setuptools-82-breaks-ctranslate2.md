---
id: setuptools-82-breaks-ctranslate2
title: 'setuptools 82.0.1+ は pkg_resources を別 distribution に分離、古い ctranslate2 の import が壊れる'
visibility: public
confidence: confirmed
outcome: resolved
tags: [python, setuptools, ctranslate2, import-error]
environment:
  setuptools: "<=75"
  ctranslate2: "4.4.0"
  python: ">=3.10"
source_project: null
source_session: "manual/2026-04-19"
created_at: 2026-04-19
updated_at: 2026-04-19
last_verified: 2026-04-19
---

## Context
Python 環境構築時、新規 venv で pip install した直後に ctranslate2 が import できない。他のパッケージは問題ない。

## Symptom
```python
>>> import ctranslate2
ModuleNotFoundError: No module named 'pkg_resources'
```
または `pkg_resources` 依存先で AttributeError。ctranslate2 自体はインストール済み。

## Cause
setuptools 82.0.1 で `pkg_resources` が本体から別 package 扱い（lazy import）になり、後方互換が壊れた。ctranslate2 4.4.0 以前（および同じパターンの古い wheel）は `pkg_resources` を top-level import として利用している。

## Resolution
- `requirements.txt` に `setuptools<=75` をピン
- 可能なら ctranslate2 を 4.5.0+ にアップデートする方が根本的（ただし [別の version pin 問題](../pyinstaller/ctranslate2-version-pin-4.5.0.md) を参照）
- 代替: `pip install setuptools-pkg-resources` で再導入する手もあるがメンテ対象外

## Evidence
- setuptools CHANGELOG 82.0.1 の「Removed pkg_resources from the default installation」を確認
- LiveTR/CLAUDE.md に「setuptools 82+ で壊れる、<=75 必須」と記録
