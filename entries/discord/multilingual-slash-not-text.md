---
id: discord-multilingual-slash-not-text
title: '多言語 Discord Bot は text trigger ではなく slash command で実装する'
visibility: public
confidence: confirmed
outcome: resolved
tags: [discord, bot, i18n, slash-commands]
environment:
  discord.js: ">=14"
  i18n: "multiple locales"
source_project: null
source_session: "manual/2026-04-19"
created_at: 2026-04-19
updated_at: 2026-04-19
last_verified: 2026-04-19
---

## Context
Discord bot で 4 言語サポート（日英中韓）。最初は「オークション開始」「Start auction」「开始拍卖」「경매 시작」を text trigger で書いていた。

## Symptom
- 言語検出がサーバ単位か user 単位かで routing が割れる
- 翻訳漏れの誤発火（他言語の trigger に日本語が反応する）
- Bot が同一言語で複数 trigger を登録しなければいけず、conflict
- rate limit / false positive の温床、テストが爆発

## Cause
Discord の message event では trigger 語彙の優先順位・言語コンテキストを bot 側で全部持たなければならない。user ごとの言語設定を lookup して、全 locale で trigger を untranslated 含めてマッチ、等、**設計上のコストが言語数 × trigger 数で増える**。

## Resolution
**slash command（`/auction start`, `/auction end`）に統一する**:
- Discord 側で localized command name / description を持てる（`/auction` は全言語共通、表示名だけ locale に応じる）
- コマンド名は universal、引数も型で受ける（string / int / user）
- 言語判定は user の Discord locale を自動利用（`interaction.locale`）
- 誤発火が構造的に起こらない（曖昧マッチが無い）

**移行のコスト**: text trigger から slash への書き換えは 1 ファイル 1 コマンド。複雑な text parsing ロジックを全部消せる。

## Evidence
- HIT Auction System の HANDOVER.md で「text 方式から slash に移行した結果、i18n bug が消滅」と記録
- Discord 公式も 2022 以降 slash を primary に推奨: https://discord.com/developers/docs/interactions/application-commands
