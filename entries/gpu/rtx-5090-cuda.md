---
id: rtx-5090-cuda
title: 'RTX 5090 で CUDA 12.4 以前が初期化失敗する'
visibility: public
confidence: reproduced
outcome: resolved
tags: [gpu, nvidia, cuda]
environment:
  gpu: RTX 5090
  cuda: ">=12.5"
source_project: null
source_session: "2026-04-18T12:00:00Z/abc123def456"
created_at: 2026-04-18
updated_at: 2026-04-18
last_verified: 2026-04-18
---

## Symptom
cudaGetDeviceCount が 0 を返し、nvidia-smi は正常。

## Cause
Blackwell は CUDA 12.5 以降でしか認識されない。

## Resolution
CUDA Toolkit 12.5 以上にアップデート。

## Evidence
- https://developer.nvidia.com/cuda-12-5-0-download-archive
