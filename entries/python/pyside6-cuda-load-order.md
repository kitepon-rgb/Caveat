---
id: pyside6-cuda-load-order
title: 'CUDA モデル（faster-whisper 等）は PySide6 import より **前に** ロードしないと segfault'
visibility: public
confidence: confirmed
outcome: resolved
tags: [python, cuda, pyside6, faster-whisper, segfault, load-order]
environment:
  pyside6: ">=6.5"
  cuda: ">=11"
  python: ">=3.10"
  os: windows
source_project: null
source_session: "manual/2026-04-19"
created_at: 2026-04-19
updated_at: 2026-04-19
last_verified: 2026-04-19
---

## Context
LiveTR で Qt GUI（PySide6）と CUDA ベースの Whisper を同プロセスで使う。main.py の初期化順で症状が分かれた。

## Symptom
PySide6 を import した後に `faster_whisper.WhisperModel(device='cuda')` を呼ぶと、モデルロードの途中でプロセスが segfault で死ぬ。stderr 出力なし。PySide6 import 前に Whisper をロードすれば問題ない。

## Cause
PySide6 (Qt 6) 初期化時に OpenGL/CUDA 系ドライバの GPU context を先取りする場合があり、後続の CUDA コンテキスト要求と race condition を起こす。Qt の GL バックエンドと cuBLAS/cuDNN の初期化が衝突する。**CUDA 初期化は必ず単独でプロセス先頭、Qt 初期化前に完了させる**必要がある。

## Resolution
```python
# main.py の冒頭（import 文より後、他の処理より前）
from faster_whisper import WhisperModel
_model = WhisperModel('large-v3', device='cuda')   # ← ここで CUDA context を完全に取る

# その後で GUI 系を import
from PySide6.QtWidgets import QApplication
```

注意: **副作用付き import 順**に依存しているので、他の CUDA 依存ライブラリ（torch、TensorRT、onnxruntime-gpu）を併用するときも同じ順序原則を守る。

## Evidence
- LiveTR/CLAUDE.md: main.py startup sequence が明記
- 再現: PySide6 を先に import → Whisper ロード途中 segfault。順序を逆にすれば 100% 回避
