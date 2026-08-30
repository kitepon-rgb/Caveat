# v0.12.0 announcement drafts

公開済リソース:
- npm: https://www.npmjs.com/package/caveat-cli (0.12.0)
- Release: https://github.com/kitepon-rgb/Caveat/releases/tag/v0.12.0
- Discussion: https://github.com/kitepon-rgb/Caveat/discussions/9
- CHANGELOG: https://github.com/kitepon-rgb/Caveat/blob/main/CHANGELOG.md#0120--2026-05-04

各プラットフォーム向けに適切なトーンで書き分けてある。投稿は手動。

---

## X (旧 Twitter) — 短文版 (英語)

> Caveat v0.12.0 — proper-noun-only matches no longer fire.
>
> Old: `RTX 5090 CUDA` in any prompt would surface every CUDA entry. Wide-net.
> New: 3 structural gates — co-occurrence + symptom-section match + corpus-rarest anchor. No keyword lists, no thresholds (other than "≥2 = co-occurrence").
>
> Bare topic mentions stay silent. Specific failure vocabulary (`cudaGetDeviceCount が 0`, `SQLITE_READONLY`) fires the right entry.
>
> https://github.com/kitepon-rgb/Caveat/releases/tag/v0.12.0

文字数: ~510 (X 280 制限なら分割必要、X Premium 拡張なら 1 投稿で OK)

### 短い分割版 (各 240 文字)

1/3
> Caveat v0.12.0 published. proper-noun-only matches no longer fire — `RTX 5090 CUDA` alone is silent, only specific failure vocabulary surfaces the right entry. 3 structural gates, no keyword lists.

2/3
> The trick: each entry has a `## Symptom` section. A prompt token has to (a) co-occur ≥2 with the entry, (b) land specifically in Symptom (not title/tags), and (c) be on the corpus-rarest side. All structural — no thresholds beyond "2".

3/3
> Why structural: any hand-curated stopword list rots, any magic threshold drifts. Corpus DF auto-derives "rare". Entry section structure auto-derives "describing the failure". Add `entries/*.md`, the gate self-extends.
> https://github.com/kitepon-rgb/Caveat

---

## X (日本語版)

> Caveat v0.12.0 を公開。事前発火を絞った。
>
> Before: `RTX 5090 CUDA` と書くだけで CUDA 関連 entry が全部 surface (wide-net)
> After: 3 段の構造的ゲート (共起 + 症状セクション一致 + corpus-rarest anchor)
>
> 「話題に触れただけ」は silent、症状語彙 (`cudaGetDeviceCount が 0`, `SQLITE_READONLY`) で正解 entry だけ発火。
>
> ハードコードリスト一切なし、magic number は 2-of-N の `2` のみ。
> https://github.com/kitepon-rgb/Caveat/releases/tag/v0.12.0

---

## Show HN (Hacker News)

タイトル候補:
- `Show HN: Caveat v0.12 – retrieval that fires only on specific failure vocabulary`
- `Show HN: structural gates for AI agent retrieval (no embeddings, no keyword lists)`

本文:

> Caveat is a long-term memory layer for Claude Code: every external-spec gotcha or repo-specific oddity gets written down once, and the next time you (or your agent) is about to step on the same rake, the relevant note auto-surfaces via Claude Code hooks.
>
> v0.12.0 is a retrieval precision pass. The previous `≥2 distinct token co-occurrence` gate had a "wide-net" failure mode: typing `RTX 5090 CUDA` in any prompt would surface every CUDA-related entry, because the proper nouns happen to co-occur in titles. The fix is structural, not statistical: three gates stack on top of co-occurrence:
>
> 1. **Symptom-section gate**: each entry has a `## Symptom` section. At least one matched token must land in that section, not just title/tags. ("Naming the topic" is insufficient evidence the user is hitting THIS trap.)
> 2. **Rare-anchor (min-DF) gate**: of the symptom-matched tokens, at least one must have minimum document frequency in the corpus. Common tool tokens (`cuda` in 30 CUDA entries' symptoms) carry no discrimination — only corpus-rare tokens (`cudaGetDeviceCount`, `SQLITE_READONLY`) actually identify the trap.
> 3. **Path / self-identity / pure-hiragana / CJK group dedup pre-filters** (env-derived, Unicode-range based, no word lists).
>
> The design constraint was: no hardcoded word lists, no magic thresholds. Everything is derived from corpus statistics, runtime env, Unicode ranges, or entry section structure. The only numeric constant in the whole pipeline is `2` (the minimum definition of co-occurrence).
>
> Empirical effect on a real ~250-entry corpus:
> - Meta-conversation prompts: 5 unrelated hits → 0
> - Bare proper-noun "RTX 5090 CUDA で何かやってる": 2 hits → 0
> - Specific symptom "RTX 5090 で cudaGetDeviceCount が 0 を返す": 1 correct hit, unchanged
> - "docker bind mount で SQLITE_READONLY": 5 hits with noise → 1 correct only
>
> Repo: https://github.com/kitepon-rgb/Caveat
> npm: `npm i -g caveat-cli@0.12.0`
> Release: https://github.com/kitepon-rgb/Caveat/releases/tag/v0.12.0
>
> Curious to hear from anyone who's done retrieval-side filtering — particularly the IDF angle, which I'd been deferring as "embedding territory" but turned out to apply cleanly at the token level.

---

## dev.to / Medium 風 (英語、長文)

タイトル: **Why our agent retrieval was firing on proper-noun coincidence — and how we fixed it without embeddings**

冒頭フック:

> A user typed `RTX 5090 CUDA で何かやってる` and our retrieval surfaced 2 entries about RTX initialization failures. The user wasn't failing — they were just naming the topic. We had a wide-net problem.
>
> This post walks through how we fixed it with three structural gates that require no keyword lists, no magic thresholds, no embedding model. The whole pipeline derives its decisions from Unicode ranges, runtime environment values, entry section structure, and corpus statistics.

(中略 — Show HN 本文を膨らませた版を本文に。最後に lesson learned。)

---

## Reddit (r/LocalLLaMA, r/programming, r/ClaudeAI)

トーン: HN より柔らかく、コンテキストを増やす。具体的なノイズ例から入る。

タイトル: `Caveat v0.12: structural gates for AI agent retrieval (no embeddings, no stopword lists)`

本文 (Show HN ベース、冒頭をストーリー風に):

> I maintain a tool called Caveat — a markdown-in-git knowledge base that surfaces gotchas via Claude Code hooks. The previous version had an embarrassing failure mode I want to share, because the fix turned out to be structurally interesting.
>
> ... (Show HN 本文と同様、ただし「Caveat とは」を 2 行で説明)

---

## Slack / Discord 1 行版

> Caveat v0.12.0 released — proper-noun matches no longer fire spurious notes. Only specific failure vocabulary (`cudaGetDeviceCount が 0`, `SQLITE_READONLY` 等) surfaces the right entry. https://github.com/kitepon-rgb/Caveat/releases/tag/v0.12.0

---

## 投稿時の注意

- **X**: 図/Before-After 比較表が刺さる。Release notes の効果テーブルをスクショ撮って添付すると視認性高い (mcp__openai-image__edit_image でテンプレ化可能)
- **Show HN**: 投稿時刻は UTC 平日朝 (= JST 平日 16-22 時) が前線露出多い。月曜は避ける (週末ストック放出と被る)
- **Reddit**: r/LocalLLaMA は agentic / RAG の関心高、r/programming は IDF の話に反応すると予想
- **dev.to / Medium**: SEO 流入狙い、X / HN とは別軌道で生かす

## 残作業 (任意、ユーザー判断)

1. **GitHub Settings UI 経由のみ**: Social preview 画像のアップロード — 現状は既に設定済 (`usesCustomOpenGraphImage: true` 確認済) → 更新不要
2. **告知 GIF**: リリース告知用 GIF (Slack 投稿等) は今回見送り。OG バナーが既にあるので X / HN への画像添付には流用可能
3. **OG 画像のバージョン違い量産**: AI 画像生成 MCP の edit 系 (`mcp__openai-image__edit_image`) で v0.12 専用バナーを派生させる選択肢あり (現状の OG は中立的なので流用で十分)
