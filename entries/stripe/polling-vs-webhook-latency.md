---
id: stripe-polling-vs-webhook-latency
title: 'Stripe subscription 状態同期を polling にすると 60 秒の遅延 SLA、webhook にする場合は受信口の複雑度が上がる'
visibility: public
confidence: reproduced
outcome: resolved
tags: [stripe, subscription, webhook, polling, latency]
environment:
  stripe: api
source_project: null
source_session: "manual/2026-04-19"
created_at: 2026-04-19
updated_at: 2026-04-19
last_verified: 2026-04-19
---

## Context
Stripe subscription の状態（active / past_due / canceled）を bot / 自作サーバ側で同期したい。2 通りある:
- Polling: `stripe.subscriptions.list()` を定期実行
- Webhook: `invoice.paid` / `customer.subscription.updated` 等を受信

## Symptom
- **Polling 60s 間隔**: sub 状態変化の反映が最大 60s 遅れる。user 目線では payment 完了してもしばらく機能が unlock されない
- **Webhook**: receiving endpoint が要る。bot アーキテクチャで Web server を持たない場合、追加で HTTP receiver を立てる必要
- **どちらも reconciliation 必要**: 一時的なネットワーク断 / Stripe 側の re-delivery で整合性が崩れる可能性

## Cause
Stripe の公式 best practice は webhook 推奨だが、receiver 運用コスト（endpoint 認証、reliable delivery、idempotency、署名検証）が小さくない。polling は構造的に simple だが linearity で cost increases。

## Resolution
**設計判断を明示的に文書化**する:
- **polling 採用なら**: 60s SLA を user に明示（「決済後最大 1 分で反映」）、polling 間隔を短くしすぎると Stripe rate limit
- **webhook 採用なら**:
  - Stripe CLI `stripe listen --forward-to localhost:PORT` で開発
  - `Stripe-Signature` header を検証（secret でなく webhook secret）
  - idempotency: `event.id` を DB に記録、既処理ならスキップ
  - 失敗時の 2xx でない応答で Stripe が retry（最大 3 日）
- **ハイブリッド**: webhook を primary、polling は safety net（1 時間おきに全 active sub を reconcile）

どちらを選ぶかは **UX tolerance × 運用工数**で判断。1 分遅延が OK なら polling 単独で十分。

## Evidence
- HIT Auction System HANDOVER.md に「polling 採用、60s SLA を docs に記載」と決定履歴
- Stripe 公式 docs: https://stripe.com/docs/webhooks/best-practices
