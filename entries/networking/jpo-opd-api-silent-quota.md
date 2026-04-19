---
id: jpo-opd-api-silent-quota
title: 'JPO OPD-API は 1 日上限に到達すると HTTP 200 + JSON body の statusCode 203 で silent fail'
visibility: public
confidence: confirmed
outcome: resolved
tags: [api, jpo, patent, quota, silent-failure]
environment:
  api: jpo-ip-data
  endpoints: "/patent/v1/global_doc_list, /patent/v1/jp_doc_cont"
source_project: null
source_session: "manual/2026-04-19"
created_at: 2026-04-19
updated_at: 2026-04-19
last_verified: 2026-04-19
---

## Context
特許庁 JPO の IP-Data OPD API（特許文献全文取得）を使って bulk 取得する job を回す。

## Symptom
- 最初 1〜2 件は正常に取得できる
- 途中から API が HTTP 200 を返すが、JSON body に `{"statusCode": 203, "message": "1日のアクセス上限を超過しました..."}` が入る
- HTTP 層では success なので、`response.ok` や status code チェックだけでは気付かない
- 取得できない patent を「取得済・中身空」として DB 書き込みしてしまう
- 翌日 API 復活後も、空レコードが残ったまま reprocess しない

## Cause
JPO OPD API の quota 超過時の response 形式が独特：
- HTTP 200（reject じゃなく accept 扱い）
- JSON body に独自 `statusCode` フィールド
- `Retry-After` header 無し、quota reset タイミングは undocumented（0:00 JST reset の模様）
- client 側で「JSON body の中の独自 status コード」を見に行かないと気付けない

## Resolution
**OPD API wrapper に JSON-level status check を入れる**:
```python
def call_opd(url, params):
    r = requests.get(url, params=params)
    r.raise_for_status()
    data = r.json()
    if data.get('statusCode') == 203:
        raise OpdQuotaExceeded(f"daily quota hit: {data.get('message')}")
    return data

# 呼び出し側:
try:
    result = call_opd(endpoint, params)
except OpdQuotaExceeded:
    # flag を立てて今日はもう呼ばない、0:00 JST まで待つ
    sys.exit(0)  # 部分データで止める、reprocess は翌日
```

**書き込み前の defensive check**:
- 取得した claims 文字列が 50 文字未満なら「取得失敗」としてスキップ
- `claims_not_available` と `fetch_failed` を分けて記録（後で reprocess 判定に使う）

**fallback**: Google Patents（公開ページ scrape）を secondary source に。ただし別 caveat 参照（scraping は fragile で claims 抜けがある）。

## Evidence
- IP プロジェクトで 20 件 fetch job を走らせたら 18 件が「空レコード」になっていた事例
- JPO OPD 仕様書: 非公開（企業契約者のみアクセス、仕様変更も周知なし）
- quota reset は 0:00 JST に実測確認
