---
id: stripe-japan-security-checklist
title: '日本で Stripe live mode を有効化するには「セキュリティ対策措置状況申告書」の事前準備が要る'
visibility: public
confidence: confirmed
outcome: resolved
tags: [stripe, japan, compliance, security]
environment:
  stripe: live-mode
  jurisdiction: japan
source_project: null
source_session: "manual/2026-04-19"
created_at: 2026-04-19
updated_at: 2026-04-19
last_verified: 2026-04-19
---

## Context
Stripe を日本で live mode に上げるとき、ダッシュボードから申請ボタンを押すだけで済むと思いがち。実際には審査で security 関連書類の記入を求められる。

## Symptom
- live mode の approval 申請が pending で詰まる
- Stripe support からメールで「セキュリティ対策措置状況申告書」の PDF リンクが送られてくる
- 記入せず放置すると approval 遅延（数日〜数週間）
- 急ぎのリリース直前に気付いて慌てる

## Cause
日本の改正割賦販売法（2018）で加盟店は card holder data のセキュリティ対策状況を申告することが義務化。Stripe は PCI DSS を代行するが、加盟店自身の「体制」は別。Stripe Checkout を使っていれば実質的な PCI scope は無いが、書類だけは必要。

## Resolution
**live 申請前にチェックリストを事前完了**:
- [ ] Stripe Checkout / Payment Element を使う（サーバが card data を touch しない構成）
- [ ] `npm audit` 定期実行（CI に組む、high/critical は修正）
- [ ] ClamAV 等の AV を server に入れる（定期 scan 設定）
- [ ] Stripe ダッシュボードの 2FA を有効化（全 admin）
- [ ] `.env` / credentials を git に入れない（pre-commit hook でブロック）
- [ ] VPS / container の SSH key-only login、パスワード認証禁止

書類記入は以下が項目:
- 加盟店情報、事業概要
- card data の取り扱い（「Stripe Checkout 使用で当社 server は card data を受信しない」と明記）
- ログ取得・不正検知・脆弱性対応の体制
- インシデント発生時の対応フロー

事前にテンプレート埋めておけば申請から live まで数日で済む。

## Evidence
- HIT Auction System の HANDOVER.md: 日本 Stripe approval で書類要求 → live 遅延 2 週間
- 経産省 割賦販売法: https://www.meti.go.jp/policy/economy/consumer/credit/kaisei2018.html
- Stripe 日本の加盟店ガイド参照
