# Phase 15: 共有 community DB の auto-merge GitHub Actions 設計

## 背景

**この変更が必要な理由**: Caveat の共有ナレッジ DB ([kitepon-rgb/Caveat](https://github.com/kitepon-rgb/Caveat)) は現状、`caveat push` で送られてくる PR をメンテナーが 1 件ずつ手動マージしている。これはスケールしないうえ、貢献から各購読者が `caveat pull` で取得できるまでの遅延も生む。本設計の目的は、安全性・品質基準で PR を自動的に検証するゲートを導入し、信頼できる貢献はメンテナーの逐次対応なしに流せるようにする一方、悪意ある PR や壊れた PR は確実に弾けるようにすること。

**既存設計から来る制約**:
- `caveat push` が作る PR はスコープが極めて狭い (`entries/<category>/<slug>.md` 単一ファイル、固定 branch、固定 PR テンプレ)。攻撃面が小さい。
- [CONTRIBUTING.md](../CONTRIBUTING.md) は CLI を使わない手動 PR (fork で md を直接置いて PR) も受け付けると明記している。ゲートは両方を扱える必要がある。
- frontmatter 検証は実質ゼロ。[packages/core/src/frontmatter.ts](../packages/core/src/frontmatter.ts) (14-21 行) は parse のみ、YAML は `JSON_SCHEMA` で unsafe タグだけ拒否されているが必須フィールドや型チェックは存在しない。
- merge 自動化はまだ無く、CI は [.github/workflows/ci.yml](../.github/workflows/ci.yml) の build/typecheck/test のみ。

**達成したい結果**: `caveat push` の pre-flight (ローカルで早期失敗) と、新規 GH Actions ワークフロー (PR 後の gate) の **両方で同じ validator を共有**。フル pass で workflow が PR を auto-approve する。**Phase A ではマージは依然メンテナーが押す**。Phase A を運用して false-negative 率が許容範囲だと確認できてから、別 PR で full auto-merge へ昇格する。

---

## アプローチ (Phase A — auto-approve のみ)

### 段階的ロールアウト

| Phase | 振る舞い | 本設計のスコープ |
|---|---|---|
| **A** | validator を必須 CI チェックとして運用、フル pass で bot が auto-approve、**メンテナーが Merge を押す** (または GitHub の "Enable auto-merge" を活用) | **本設計に含む** |
| **B** | フル pass で workflow が `gh pr merge --auto --squash` を実行 | **本設計には含まない**。Phase A を数週間運用したのち別 PR |

判断根拠: validator には false-negative リスクがある。実 PR を観察してから人間ゲートを完全に外したい。branch protection で「CI green + 1 approval (bot)」を要求すれば、実質的なスケール効果は同等のまま、人間を最終バックストップとして残せる。

### 10 ゲート validator

各ゲートは独立に判定し、OK / FAIL を行番号・フィールド情報付きで報告する。順序は**安価 → 高価、副作用なし → 副作用あり**で、失敗が早く見える。

| # | ゲート | ルール |
|---|---|---|
| 1 | **diff-scope** | 変更パスが全て `entries/<cat>/<slug>.md` にマッチ。それ以外のファイル変更を含めば fail。 |
| 2 | **file-count + size** | 1 PR ≤ 5 ファイル、各ファイル ≤ 16 KB。 |
| 3 | **encoding + filename** | UTF-8 (BOM なし)、通常ファイル (symlink / LFS 拒否)、ファイル名 `^[a-z0-9][a-z0-9-]*\.md$`、category `^[a-z][a-z0-9-]*$`、NFC 正規化、Windows 予約名 (CON, NUL, ...) 拒否。 |
| 4 | **yaml safe-parse** | `gray-matter` + `JSON_SCHEMA` (既に強制済) に加え、上限を導入: anchor ≤ 50 個、ネスト ≤ 8 段、YAML 全体 ≤ 8 KB、各文字列 ≤ 1 KB。 |
| 5 | **frontmatter schema** | zod スキーマで必須フィールド (`id`, `title`, `visibility`, `confidence`, `tags`, `environment`, `created_at`, `updated_at`, `source_session`) と型・enum を validate。**`visibility === 'public'` を厳格に強制**。 |
| 6 | **id↔slug** | `frontmatter.id === <ファイル名から .md を除いた slug>`。 |
| 7 | **id 衝突** | main の `entries/**/*.md` を全 scan、別 path で同一 id があれば reject。同 path の更新 (update) は OK。並行マージとの race は branch protection の「Require branch up-to-date」で抑える。 |
| 8 | **markdown HTML 安全** | 本文に `<script`, `<iframe`, `<object`, `<embed`, `<svg`, `javascript:` URL、`data:` URL 画像が含まれていれば reject。 |
| 9 | **link 安全** | 相対 link (`[x](./a)` および `[[wikilink]]`) は `..` を含まず、`entries/` 配下に解決される必要がある。絶対 URL の外部 link は許容。 |
| 10 | **secret regex** | 本文 + frontmatter に対して代表的クレデンシャルパターンを検出: `AKIA[0-9A-Z]{16}`、`ghp_[A-Za-z0-9]{36,}`、`sk-[A-Za-z0-9]{40,}`、`-----BEGIN [A-Z ]+PRIVATE KEY-----`。 |

**v1 から外す項目**: 貢献者レピュテーション、LLM 品質スコアリング、embedding ベース重複検出、HMAC 署名済 `source_session`。これらは Phase B 以降 (下記「将来」セクション参照)。

### 共有 validator コード

validator は `packages/core/src/prValidator.ts` に **純関数として** 配置し、**2 つの呼び出し元から共有**する:

1. **`caveat push` CLI** ([packages/core/src/push.ts](../packages/core/src/push.ts) 80-86 行) — `gh pr create` 直前に呼ぶ。FAIL があれば abort し修正案を出力。これでローカル段階で 90% の問題を弾き、PR ラウンドトリップを節約する。
2. **GH Actions ワークフロー** — `.github/scripts/run-validator.mjs` が `GITHUB_EVENT_PATH` から PR の diff を読み、同じ validator を呼び、構造化された report を出力。

関数シグネチャ案:

```ts
interface GateResult {
  gate: string;          // 例: "frontmatter-schema"
  status: 'ok' | 'fail';
  detail?: string;       // 人間可読、line/field 情報を含む
  fixHint?: string;      // 修正案 markdown スニペット
}

function validateEntryFiles(opts: {
  files: { path: string; content: string }[];
  mainEntries: { path: string; id: string }[];
}): GateResult[];
```

### ワークフロー設計

`.github/workflows/auto-merge.yml`:

- **イベント**: `pull_request` (`pull_request_target` ではない — fork が制御するコードに repo secrets を渡さないため)。
- **ジョブ**: `validate` を `ubuntu-latest` / Node 24 で実行。
- **ステップ**: PR head SHA を checkout → Node + corepack セットアップ → `pnpm install --frozen-lockfile` → `pnpm --filter @caveat/core build` → `node .github/scripts/run-validator.mjs`。
- **フル pass 時**: `gh pr review --approve --body "..."`、OK/FAIL grid をまとめた sticky comment 投稿、label `auto-merge-ready` を付与。
- **fail 時**: exit code ≠ 0、失敗ゲート + 修正ヒントを sticky comment に書き、label `needs-changes` を付与。
- **sticky comment**: PR ごとに 1 件のみ。隠しマーカー (`<!-- caveat-validator -->` 等) で識別し、`gh pr comment --edit-last` か API で更新する。連投しない。

### branch protection (手動設定、計画書のみ)

ワークフロー land 後、メンテナーが `main` に対して GitHub Web UI から設定:
- PR を必須化
- ステータスチェック `validate` の pass を必須化
- 1 件の approval を必須化 (auto-approve でこれを bot が満たす)
- merge 前に branch を up-to-date にする要件 (id 衝突 race への対策)

これは 1 回限りの手動操作。merge コミットメッセージにも記録する。

---

## 重要ファイル

### 新規

- [.github/workflows/auto-merge.yml](../.github/workflows/auto-merge.yml) — ワークフロー
- [.github/scripts/run-validator.mjs](../.github/scripts/run-validator.mjs) — ワークフロー entry。`gh pr diff` または filesystem から PR diff を読み、validator を呼び、sticky comment 用 markdown を整形
- [packages/core/src/prValidator.ts](../packages/core/src/prValidator.ts) — 純 validator (10 ゲート)
- [packages/core/tests/prValidator.test.ts](../packages/core/tests/prValidator.test.ts) — 単体テスト (各ゲートの pass/fail、加えて実体に近い fixture 群での統合テスト)

### 既存変更

- [packages/core/src/push.ts](../packages/core/src/push.ts) — 86 行付近 (`visibility-private` チェックの後、`gh pr create` の前) で `validateEntryFiles` を呼ぶ。新規 return status `validator-failed` を追加
- [packages/core/src/index.ts](../packages/core/src/index.ts) — `export * from './prValidator.js';`
- [apps/cli/src/commands/push.ts](../apps/cli/src/commands/push.ts) — `validator-failed` status を扱い、各 gate 失敗を fix hint 付きで表示
- [packages/core/src/types.ts](../packages/core/src/types.ts) — `Frontmatter` の zod スキーマを抽出するか検討 (prValidator.ts に置く案も可。後者は types.ts にランタイム依存を持ち込まない利点)
- [CONTRIBUTING.md](../CONTRIBUTING.md) — "Maintainer merges PRs that pass the visibility gate" の記述を更新、10 ゲートを列挙して貢献者に何が検査されるか提示、`caveat push` が同 validator をローカル実行する旨を追記
- [docs/plan.md](plan.md) — 「Phase 15: PR auto-validation」節を新設し、設計と v1/v2 分割を記録

### 再利用 (変更なし)

- [packages/core/src/frontmatter.ts](../packages/core/src/frontmatter.ts) — `parseMarkdown` (YAML parse + section split)
- [packages/core/src/community.ts](../packages/core/src/community.ts) (7 行) — `GITHUB_URL_RE` と slug 規則 (ファイル名パターン参照)
- `gray-matter` + `js-yaml` (既存依存。`JSON_SCHEMA` engine を再利用)
- `zod` (MCP ツールで既に使用、例: [apps/mcp/src/tools/search.ts](../apps/mcp/src/tools/search.ts))

---

## 検証

実装 land 後の end-to-end テスト計画:

1. **Validator 単体テスト**: `corepack pnpm --filter @caveat/core test -- tests/prValidator.test.ts` — 各 gate を pass fixture と最低 1 件の fail fixture で exercise。加えて `entries/claude-code/` から借りた実体に近い entry での "happy path" 全 validation テスト。
2. **CLI pre-flight**: `~/.caveat/own/entries/misc/` 配下に壊れた entry を配置、`caveat push <id> --dry-run` を実行、新規 `status: validator-failed` + 各 gate 失敗の可読リストが返ることを確認。
3. **ワークフロー syntax**: `actionlint` (軽量 CLI) を `auto-merge.yml` に通す。可能なら `act` でローカル実行も。
4. **Live PR canary**: 別 test fork から PR を 2 件投げる。(a) 正常 entry → bot approve + sticky-comment 全 OK を期待。(b) 故意に壊した entry (例: `visibility: private`、サイズ超過、本文に `<script>`) → 失敗 sticky-comment が該当 gate 名を出すことを期待。
5. **branch protection**: `main` に対して GitHub Web UI から設定し、PR が `validate` ステータス green なしには merge できないことを確認。
6. **回帰テスト**: `corepack pnpm -r test` の合計が現状 (152 件) 通りグリーン。新規テスト追加で 170+ 件になる想定。

merge コミットおよび `docs/plan.md` の Phase 15 entry に、Phase B (full auto-merge) を意図的に保留した旨を記載する。

---

## 将来 (本設計のスコープ外)

- **Phase B**: Phase A を約 4 週間 / 約 20 件 merge 運用し false-negative ゼロを確認したのち、`gh pr merge --auto --squash` へ切替。
- **Trust tier**: 5 件以上 clean merge 実績のある貢献者は gate 検査を緩和 (例: id-collision deep scan を skip)。状態を持つので JSON ファイルか label で管理。
- **品質 LLM**: 軽量モデル (Haiku) で「これは本当に再利用可能な trap か?」を判定 — comment のみ、block はしない。10 hard gate を pass した PR にのみ走らせてコスト上限を確保。
- **Embedding 重複検出**: 近傍 entry を comment で警告。
- **Canary merge**: `incoming/` ブランチに auto-merge し、日次バッチで `main` に rebase 昇格。
- **HMAC 署名済 `source_session`**: CLI 側で auto-fill した値の改竄検出。
