# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクトの状態

**v0.17.4（2026-08-23公開）**。挙動不変の内部リファクタ。OS依存分岐を
[packages/core/src/platform.ts](packages/core/src/platform.ts)へ、Claude/Codex両インストーラの逐語重複を
[apps/cli/src/installShared.ts](apps/cli/src/installShared.ts)へ、hookCmd/codexHookCmdの逐語重複エンジンを
[apps/cli/src/hookShared.ts](apps/cli/src/hookShared.ts)（`HookHost`設定で切替）へ集約した。
「Macを直すとWinが壊れる／Claudeを直すとCodexが壊れる」構造の恒久対策。
分離規約は下記「OS依存・ホスト依存の分離規約」節が正。

**v0.17.1（2026-07-20公開）**。Windows native Codex hook commandのquoted Node実行に
PowerShell call operator `&`を付け、reinstallで旧commandを移行する。v0.17.0では
record/update直後のbackground sync、15分autosync、失敗時6時間backoff、Windows ACL seamの
15秒boundとtyped failureを公開した。

**v0.16.2（2026-07-13公開）**。Codex sidecar advisoryのproduction presetを、synthetic/publicの
Stop・tool-error各4 independent runsで8/8完遂、known-bad 0、有効解8/8、miniより低い
実測credits/runを示した`gpt-5.6-luna` lowへ更新。hookからは生error/search/path/sessionを送らず、
閉じたtool/failure種別とStop countだけをstrictな`caveat-hook-signal` blockとして渡す。
paired synthetic比較（control/signal各4）では有効解0/4→4/4、known-bad 1/4→0/4、
追加cost +0.005094 credits/run（約3.9%）。実incident一般への外挿はしない（正典:
[docs/archive/09_sidecar_hook_signal_contract.md](docs/archive/09_sidecar_hook_signal_contract.md)）。初回behavioral
characterizationはbounded authorization scenario 1件を`gpt-5.6-sol` / `claude-sonnet-5`で
control/caveat各2 run実行し、両hostともcontrol時点からsafe-and-useful 2/2、known-bad 0/2で
差0。天井効果のため害も増分効果も未観測で、一般化はしない。

**v0.15.0**（2026-07-11、272 tests passing、全 workspace typecheck passing）。**共有を製品化し、索引を自己修復にした（設計正典は [docs/06_sharing_and_reindex.md](docs/06_sharing_and_reindex.md)）**。(1) **visibility の定義を「配布範囲の上限」に更新** — `private` = 保有境界内（個人の全端末・組織 = 同じ private remote を push/pull できる人たち）、`public` = 世界。core の未指定フォールバックは `public` → `private` に変更（MCP は依然 zod 必須）。(2) **`caveat sync`** — own を private remote と同期。実効 push URL（`get-url --push --all`、insteadOf 適用後）を匿名可読 probe（credential 無しで smart-HTTP info/refs を GET）し、**anonymous-readable なら無条件拒否**（多重 pushurl・credential 埋め込み URL・403 の WAF 誤検知まで敵対的検証で塞いだ）。未設定時は `gh` で `<user>/Caveat-Private` を確認 1 回で自動作成。(3) **`caveat publish`** — `visibility: public` のみを `<user>/Caveat-Public` へ一方向全置換ミラー（`.git` 以外を全消し → public のみ再配置 → ミラー全ツリーを再検証、invalid 1 件で全体中止、TOCTOU 排除で検査済み bytes を持ち回り）。(4) **自動再索引** — Stop hook が entries ツリーの (source, relpath, mtime, size) ダイジェスト変化を検知し detached worker で全 source 再走査（他端末から git 同期されたエントリが hook・検索に載らなかった問題の恒久対策。`CAVEAT_INDEX_AUTOSYNC=off` で無効化）。(5) `caveat community add <username>` が裸ユーザー名を `<name>/Caveat-Public` に展開。source_project は引き続き null 固定（01_plan の cwd 自動推定は廃案として清算済み）。

**v0.14.8**（2026-05-08 公開、259 tests passing、全 workspace typecheck passing）。**`<caveatHome>/pending/<sessionId>/` の自動掃除を追加**。Stop hook 冒頭で `maybeSweepPendingDirs` を 1 日デバウンスで呼び、最新 mtime が 7 日以上前のサブツリーを丸ごと削除する。マーカー `<caveatHome>/pending/.last-sweep` で同日中の連続発火をスキップ、`CAVEAT_PENDING_SWEEP=off` で完全停止。`caveat init` も belt-and-suspenders で同じ sweep を呼ぶ（`--pending-stale-days <n>` で閾値上書き、dry-run は予告ログのみ）。アクティブセッションは append/drain で mtime が更新されるため回収されない。

**v0.14.7**（2026-05-06 公開、247 tests passing、全 workspace typecheck passing）。Codex sidecar advisory が明示モデルポリシ (`gpt-5.4-mini` low reasoning) で動作する `advisory` preset を採用し、Claude hook の advisory 呼び出しは `--preset advisory` 経由になった。リリース smoke スクリプトを再利用可能化、CI で `caveat-cli` packed tarball の `workspace:` リーク検査と install + `--version` 確認を追加。Windows release-pack ジョブは `corepack.cmd` / `npm.cmd` のためにシェル経由実行。2026-05-08 に Claude 生成応答 smoke を再実行して全項目クリア（[docs/05_next_session.md](docs/05_next_session.md)）。

**v0.14.6**（2026-05-06、245 tests passing、全 workspace typecheck passing）。**Claude / Codex とも Stop reminder はその場で最終回答に混ぜず pending 化し、次の context-capable hook で compact して出す**。Codex 側は `caveat codex-hook install|diagnostics|user-prompt-submit|post-tool-use|stop` で Codex runtime から Caveat CLI を直接呼ぶ。Claude 側は従来の `caveat hook post-tool-use` を `PostToolUse` と `PostToolUseFailure` の両方に登録する。現行 Claude Code は失敗 tool で `PostToolUseFailure` を出し、payload の `error` field に失敗内容を入れるため、Caveat はこの field も既存の非同期 worker / pending reminder 経路へ流す。prompt surface は `symptom_text` が失敗状態を述べる根拠、`topical_text` が罠の主題と重なる根拠として独立に要求する。

**v0.14.2**（2026-05-06、238 tests passing、全 workspace test/typecheck passing）。**Codex primary hooks を追加し、Claude hook 実運用の失敗イベントも補正済み。さらに事前発火 rare-anchor を `symptom_text` 依存から `topical_text` 依存へ修正**。Codex 側は `caveat codex-hook install|diagnostics|user-prompt-submit|post-tool-use|stop` で Codex runtime から Caveat CLI を直接呼ぶ。Claude 側は従来の `caveat hook post-tool-use` を `PostToolUse` と `PostToolUseFailure` の両方に登録する。現行 Claude Code は失敗 tool で `PostToolUseFailure` を出し、payload の `error` field に失敗内容を入れるため、Caveat はこの field も既存の非同期 worker / pending reminder 経路へ流す。prompt surface は `symptom_text` が失敗状態を述べる根拠、`topical_text` が罠の主題と重なる根拠として独立に要求する。

**v0.13.0**（2026-05-05、217 tests passing）。**Codex sidecar advisory を Claude hook の補助経路として追加**。Caveat の思想は変更しない: 既存の UserPromptSubmit / PostToolUse / Stop が「いつCaveatを出すか」を決め、本文先頭の `[caveat]` リマインダーも従来通り維持する。その後ろに、現在の project で `.codex-sidecar.yml` があり `codex-sidecar` が operational な場合だけ `[caveat:codex-sidecar] Codex advisory:` を追記する。

追加点:
- `caveat codex-sidecar diagnostics|smoke|run|work-smoke` を CLI に追加。Caveat DB 検索 → `caveat_entry` context block → `codex-sidecar --context-file` → structured `SidecarResult` の経路を持つ
- Hook advisory は `CAVEAT_HOOK_CODEX_SIDECAR=off|auto|require` で制御。default `auto` は `.codex-sidecar.yml` がある project だけ試す。失敗時は hidden fallback せず `[caveat:codex-sidecar] advisory unavailable: ...` を明示
- `AGENTS.md` は Codex 向けの薄い入口で、`CLAUDE.md` を正本として扱う。Claude 固有の契約を Codex 風に書き換えない
- `docs/03_dual_agent_support.md` に Claude contract / Codex adapter / hook advisory / execution policy を記録

**v0.12.0**（2026-05-04、202 tests passing、schema v3）。**事前発火の精度改善 — 「固有名詞だけでHIT してはいけない」を構造的ゲートで実装**。語の偶然一致 (wide-net) では「関連性」が表現できないという根本反省から、**症状特異語ゲート + rare-anchor (min-DF) ゲート**を既存の 2-of-N 共起の上に追加。プロンプトが「話題に触れただけ」(`RTX 5090 CUDA で何かやってる`) の段階では silent、症状語彙が来た瞬間 (`RTX 5090 で cudaGetDeviceCount が 0 を返す`) に該当 entry を 1 件返す。

主な追加ゲート (全て構造由来、リスト一切なし):
- **schema v3**: `entries.topical_text` (title + tags + environment 値) と `entries.symptom_text` (`## Symptom` 本文) を indexer で派生。`migrations/003_section_roles.sql` で v2 → v3 自動 migration、JS 側 (`db.ts::backfillRoleTexts`) で既存行を backfill
- **症状特異語ゲート**: マッチしたトークンのうち最低 1 つが entry の `symptom_text` に出現すること。title-only マッチ (例: `RTX 5090` だけ) は silent
- **rare topical-anchor ゲート (min-DF、v0.14.2 修正)**: `topical_text` に出現した prompt token のうち最低 1 つが、prompt 内で corpus DF 最小タイのものであること。`symptom_text` は失敗状態、`topical_text` は罠の主題として独立に要求する。corpus 全域に蔓延する一般語 (`cuda`, `発生する` 等) は自動的に除外。閾値の magic number なし、corpus 自動算出
- **パス除去**: `\\wsl...`, `C:\...`, `/home/...` 等の path-shape 部分文字列を tokenize 前に剥がす (URL は preserve)
- **自己同名除去**: `os.userInfo().username` と `os.homedir()` の path 成分を `defaultSelfIdentityTokens()` として除外。**ハードコードリストは禁止** — `caveat` のツールブランド名も意図的に追加しない (rare-anchor が高 DF として構造的に弾く)
- **純ひらがなトリグラム除外**: `してる` `のまま` `になっ` 等の純ひらがな 3-gram は conjugational glue として捨てる (Unicode 範囲ベース、リストなし)
- **CJK 句単位グループ統合**: 1 CJK 連続 run から派生する複数の 3-gram を 1 グループ扱い。「発生する」が `発生す` + `生する` の 2 トークンに展開して 2-of-N を勝手に満たす問題を解決
- **症状検査の word-boundary 化**: ASCII トークンは Unicode 単語境界 `(?:^|[^\p{L}\p{N}])tok(?:[^\p{L}\p{N}]|$)` で照合。`CUDA` が `cudaGetDeviceCount` の substring で誤マッチする問題を解決。CJK は substring 維持

**設計思想**: 「list で除外する」のではなく「構造で要求する」が一貫した原則。閾値は 2-of-N の `2` のみ (= co-occurrence の最小定義)。これ以外の magic number / ハードコードリストは存在しない。新しい罠カテゴリは `entries/` に書くだけで自動的に取り扱い対象になる、という v0.8 の自己拡張性は維持。

**v0.11.0**（2026-04-23、203 tests passing）。**Private tier 拡張 — Caveat の対象を「第三者の外部仕様の罠」だけから「コード読解では復元できない repo 固有文脈」まで広げる**。
- v0.6.2 の「visibility は必ずユーザに聞け、自動分類禁止」は廃案。`caveat_record` / `caveat_update` は二項基準で自動判定する: 第三者が再現できる罠なら `public`、repo 固有 / 独自設計 / このプロジェクトでしか起きない文脈なら `private`、迷ったら `private`。ただしユーザ明示依頼（「これは private で記録して」等）は自動判定に優先
- **検索層の切替はしない**。2 語共起ルールを両層で統一。本文語彙が自然に仕分ける（public は外部ツール名、private は repo 固有識別子）
- **`caveat_search` に visibility 3 択**（`'public' | 'private' | 'all'`、default: 全部）を追加。Claude が自発的に絞りたい時のみ使う
- **schema v2**: `entries.last_hit_at` カラム追加。検索ヒット後に `markHit(db, hits)` で時刻更新。既存 v1 DB は `migrations/002_last_hit_at.sql` で自動 migration
- **`caveat stale` CLI 新規**: 最後浮上から N 日（default 90）経ったエントリ一覧、`--visibility private` で絞れる。月次点検で埋もれ検出 → 本文書き直し or 削除の判断材料
- **Stop hook リマインダ拡張**: 分類ヒント（WebSearch/WebFetch あり→ public 寄り / なし→ private 寄り）と二項基準の一言を追加
- 詳細: [docs/private-tier-design.md](docs/private-tier-design.md)（設計思想）、[docs/private-tier-implementation.md](docs/private-tier-implementation.md)（実装計画）

**v0.10.0**（2026-04-22、192 tests passing）。**実行中発火（PostToolUse hook）を追加、3 発火点の非同期アーキテクチャに**。tool_response が `is_error: true` のとき前景 hook は「pending queue の drain + 検索タスクの detached worker spawn」を ~20ms で返し、worker が非同期に FTS を走らせて pending ファイルに reminder を書き込む → 次の hook 呼び出しで drain されて Claude のコンテキストに載る。ユーザー応答はブロックしない。詳細は下記「Claude Code Hook の実装」節。

**v0.9.0**（2026-04-22）。**事後発火（Stop hook）を signal-based gate + co-occurrence FTS に刷新**。transcript JSONL を解析して tool failure / 同一ファイル複数編集 / WebSearch / WebFetch / Bash 再実行 の客観シグナルを抽出 → いずれか 1 つでも観測されたら発火（閾値チューニング不要）。発火時はリマインダに具体的シグナル数値 + error message / 検索クエリを元に co-occurrence FTS した既存罠を埋め込み、`caveat_update` or `caveat_record` の判断材料を渡す。無自覚に乗り越えたケースも transcript の fingerprint で拾える。

**v0.8.0**（2026-04-22）。**事前発火（UserPromptSubmit hook）を keyword allowlist から co-occurrence ベースに置換**。プロンプトを tokenize → 各 token を個別に FTS5 検索 → **≥ 2 個の distinct token が共起する entry のみ** を hit とみなし、リマインダ本文に id/title/症状抜粋を直接埋め込む。hardcoded list（keyword allowlist / stopword list）を一切使わない構造的ルール。新しい罠カテゴリを `entries/` に書くだけで trigger が自己拡張する。

**v0.7.0**（2026-04-19）。**中央 shared community DB を全廃止し、個人 / グループ単位の repo 共有モデルに pivot 済**。各ユーザーは自分の `~/.caveat/own/` に書き、共有は自分・知人・組織の git repo に普通の `git push` で行い、他のグループの知識は `caveat community add <github-url>` で取り込む。tool 側は publish 経路に介在しない。MCP tool は 6 種（search/get/record/update/list_recent/pull）— v0.7 で `caveat_push` を削除。

**v0.7 pivot の根拠**: 自動マージ厳密化を検討した結果、赤の他人からの貢献を auto-validate するモデル自体が原理的に脆弱と判明。LLM oracle (Opus 含) を gate に置いても adversarial gradient 攻撃で破られる、xz-utils 型の long-game は静的検査で検知不能。よって信頼を「自動検査」ではなく「社会的文脈」で引く方針に転換。詳細は [docs/archive/auto-merge-design.md](docs/archive/auto-merge-design.md)（廃止された自動マージ設計）参照。

**GitHub に push 済**:
- Tool (public): https://github.com/kitepon-rgb/Caveat
- 旧 `kitepon-rgb/caveats-quo` は削除済。kitepon-rgb/Caveat 自体の `entries/` は公開 dogfood reference として残す（tool は自動 subscribe しない、他人が手動 `community add` 可）

**`docs/00_overview.md` が文書の入口、`docs/01_plan.md` が設計の真実の源**。アーキテクチャ判断の前に必ず読む。`docs/02_audit.md` には過去に議論・却下した論点が残っているので蒸し返さない。`docs/archive/` には没案や別セッション由来の設計メモが置いてある（現役資料ではない）。

## コマンド

pnpm 10.0.0 が `packageManager` で pin。pnpm 10 はビルドスクリプトをデフォルトブロック、ホワイトリストは root `package.json` の `pnpm.onlyBuiltDependencies`。CLI パッケージ名は `caveat-cli`（bin は `caveat`）、他の workspace パッケージは `@caveat/core` / `@caveat/mcp` / `@caveat/web`。

**root の script（`check:release-smoke` / `check:npm-pack` / `eval:*` など、内部で `scripts/pnpm.mjs` を呼ぶもの）は `corepack` を挟まずに実行する**。`corepack pnpm <script>` は子プロセスへ `COREPACK_ROOT` を継承させる。`scripts/pnpm.mjs` は PATH 上の `pnpm` を最優先で拾うので、**PATH に pin と違う major の pnpm がある端末**では、その pnpm が `COREPACK_ROOT` を見て「corepack 配下では version を切り替えられない」と判断して硬エラーになる（単体で叩けば同じ pnpm が `packageManager` を読んで pin へ self-switch するため、`corepack` を外すだけで通る）。`--pm-on-fail=ignore` での黙らせは、pin と違う版で走らせることになるので使わない。PATH に pnpm が無い端末では `scripts/pnpm.mjs` が corepack へ fallback するため、この罠は出ない。

```sh
corepack pnpm install                              # workspace 依存をインストール
corepack pnpm --filter @caveat/core test           # core tests（181 tests）
corepack pnpm --filter @caveat/core build          # tsup + schema.sql / migrations を dist へコピー
corepack pnpm --filter caveat-cli test             # CLI smoke + installer tests（32 tests）
corepack pnpm --filter caveat-cli build            # CLI ビルド（bundle + workspace deps noExternal + dist/caveat.js 生成）
corepack pnpm --filter @caveat/mcp test            # MCP tool-handler tests（8 tests）
corepack pnpm --filter @caveat/web test            # Web tests（17 tests）
corepack pnpm -r build                             # 全 workspace パッケージをビルド
node scripts/pnpm.mjs eval:hook-search             # private golden による hook 検索 characterization
node scripts/pnpm.mjs prepare:proposal-review      # local-only masked review packet を生成
node scripts/pnpm.mjs prepare:proposal-execution   # local-only execution plan を生成（モデル未呼出し）
node scripts/pnpm.mjs run:proposal-execution       # 承認済み plan を実行し terminal receipt を生成
node scripts/pnpm.mjs test:proposal-execution      # fake CLI だけで execution harness をE2E検証
node scripts/pnpm.mjs prepare:proposal-execution-review # completed outcomeだけのmasked review packetを生成
node scripts/pnpm.mjs eval:proposal-execution      # 全plan分母のexecution-aware評価を集計
node scripts/pnpm.mjs eval:proposal-quality        # local-only masked judgment artifact を検証・集計

# ローカルで配布形態をテスト:
cd apps/cli && corepack pnpm pack                  # caveat-cli-0.x.y.tgz を生成
npm install -g ./caveat-cli-0.5.0.tgz              # 別シェル/別ホストでも同様
caveat init                                        # ~/.caveat/ を scaffold + Claude Code 連携
caveat uninstall                                   # Claude 連携を戻す（~/.caveat/ は残す）

# ビルド済みバイナリの直接実行（リポジトリ内デバッグ用）:
node apps/cli/dist/caveat.js <subcommand>          # 警告抑制ラッパ経由
node apps/cli/dist/caveat.js serve --port 4242     # Web ポータル
node apps/cli/dist/caveat.js mcp-server            # MCP stdio（手動テスト時）
```

単一テストファイル: `corepack pnpm --filter @caveat/core test -- tests/env.test.ts`
単一 describe/it: `corepack pnpm --filter @caveat/core test -- -t "envMatch"`

### 評価レーンの分離

検索精度とモデル行動を同じ指標へ混ぜない。`eval:hook-search` は query から関連 entry を
返せるかを測る offline retrieval characterization、`eval:proposal-quality` は固定 scenario と
固定 reminder の control / caveat 成果物を masked review で検証・集計する
offline self-attested proposal artifact aggregator である。
後者は host / model / policy ごとに分離し、known-bad claim rate と valid solution rate を同時に
測る。live task の warning holdout や raw transcript の常時保存は行わず、online effectiveness は
提示・回答・訂正・結果を結ぶ同意済み観測が実装されるまで名乗らない。
assignment manifest は割付の内部整合性を再計算するが事前登録時刻までは証明しないため、
pre-run digest を外部固定していない値を因果効果とは呼ばない。execution-provenance harness は
request bytes、condition envelope、provider run ID、model provenance、terminal receiptを保存・検証し、
execution-aware compilerは全planを分母へ入れる。ただしprovider署名や外部timestampは持たないため、
結果はbounded offline characterizationとして扱い、実利用全体へ一般化しない。

proposal evaluation artifact は knowledge repo ではなく
`<caveatHome>/local-eval/proposal/{scenarios,policies,assignments,trials,review-packets,judgments}.jsonl` に置く。runner は親 directory `0700`、
file `0600` を fail-closed で要求し、stdout へは digest と集計だけを出す。契約と非目標は
[docs/archive/08_proposal_effectiveness_eval.md](docs/archive/08_proposal_effectiveness_eval.md) を正とする。

Project-local `.claude/settings.json` は端末固有の permission allowlist なので repo には作らない。必要な場合は Claude Code の fewer-permission-prompts 生成手順でローカル作成し、既存の `**/.claude/` ignore のまま管理する。

## アーキテクチャ

**`markdown-in-git` が真実の源**。SQLite は再構築可能な派生 FTS5 インデックスで `<caveatHome>/index/caveat.db`（gitignore）。SQLite DB を権威扱いしない — 必ず markdown から再生成できる状態を保つ。

**単一 repo**: v0.5 から tool 本体と共有ナレッジ DB を本 repo に統合（`entries/` が共有 DB 本体）。ユーザ個人の repo は `<caveatHome>/own/`（`~/.caveat/own/`）、`~/.caveatrc.json` の `knowledgeRepo` で絶対パス上書き可。個人の絶対パスを tool repo に書かない。

**caveatHome の解決**: `findCaveatHome(userHome)` → `process.env.CAVEAT_HOME ?? join(userHome, '.caveat')`。NPM グローバルインストール時、tool の実体は `node_modules/caveat-cli/` に置かれるが、**ユーザーデータ（DB・own repo）は常に `~/.caveat/` 側**。テストは `CAVEAT_HOME` override で一時ディレクトリに隔離する。

**source 名前空間**: 全行が `source ∈ {'own', 'community/<handle>'}` を持つ。PK は `(source, id)` 複合 — community 取り込みで `own` と衝突しないための必須条件。`packages/core/src/schema.sql` 参照。

**FTS5 はトリガ経由で同期**: `entries_fts` は `entries.rowid` に対する external-content。`schema.sql` の 3 トリガ（ai/ad/au）が FTS を同期する。インデクサコードは `entries_fts` を直接触らない — `entries` への UPDATE/INSERT/DELETE のみ。

**インデクサの意味論**: `scanSource(db, source, entriesRoot)` は 1 source ずつ走査し、タッチした rowid の TEMP table を経由して**その source 内の**未タッチ行のみ削除する。全 source を 1 パスで走査すると他 source を巻き込んで削除するので絶対にしない。

**単一ファイル upsert 経路**: `upsertEntry(db, row)` は `caveat_record` / `caveat_update` の md 書き込み後に同期呼びする。MCP ツールは必ず同一プロセスで同期呼びしないと、直後の `caveat_search` で新規行が拾えない。

## FTS5 クエリのサニタイズ（Phase 9 で追加）

- `repository.ts` の `search()` は内部で `sanitizeFtsQuery` を呼び、user-provided query の**非英数・非 CJK 文字を空白に置換してから各トークンを `"..."` で quote** する
- これで `node:sqlite` / `node.js` / `a+b*c` 等の FTS5 operator に該当する文字を含むクエリでも死なない
- 代償: FTS5 の高度な演算子（`NEAR`, `OR`, `-negative` 等）は使えない。v1 は全部シンプルな phrase AND 扱い
- 必要になったら `search({ query, raw: true })` を追加して生クエリパスを開ける（v1 には入れない）

## スタック固有の罠（Phase 2/3 で検証済、Phase 12 で bundle 側も解決）

- **DB は `node:sqlite`（builtin、Node 22.5+）** — `better-sqlite3` ではない。MSVC の無い Windows ではネイティブビルド不能、かつ `better-sqlite3` 12.x は Node 24 prebuild 未提供。`node:sqlite` はプロセスごとに `ExperimentalWarning` を 1 回出す（stderr、1 行）。Phase 12 で CLI バイナリは [dist/caveat.js](apps/cli/dist/caveat.js) という薄い bootstrap ラッパを経由する — 静的 import を持たず、`process.removeAllListeners('warning')` + カスタムハンドラで SQLite 警告だけ抑制してから `import('./index.js')` で本体をロード。ESM import 巻き上げを回避するため **同一モジュール内の banner では抑制できない**。MCP サーバは stdout に JSON-RPC 以外を書けないので spawn 時に `--disable-warning=ExperimentalWarning` も併用する（belt & suspenders）。
- **`packages/core` は `tsup` を `bundle: false` で使う**。bundle すると esbuild が dist 出力時に `node:` プレフィクスを剥がす（例: `from 'node:sqlite'` → `from 'sqlite'`）。bundle せず `entry: ['src/**/*.ts']` でファイル個別出力にすると prefix が保持される。
- **`apps/cli` は `tsup` を `bundle: true` + `noExternal: ['@caveat/*']` + onSuccess で `node:` プレフィクスを復元**（`NODE_BUILTINS` を全走査して `from "fs"` → `from "node:fs"` など regex 置換）。CJS 依存（gray-matter）のため banner で `createRequire` shim を注入。`schema.sql` + `migrations/` も onSuccess で `dist/` にコピー。
- **vitest 4 + vite 7 必須**。vitest 2 + vite 5 は `node:sqlite` の import を解決できない（`node:` プレフィクスを剥がす）。
- **FTS5 trigram は 3 文字以上のクエリが必要**。日本語 2 文字（例: `仕様`）はヒットしない。ドキュメント化済の仕様なので、クエリの事前バリデーションは足さない。
- **gray-matter の YAML エンジン**は `jsyaml.JSON_SCHEMA` に固定。`!!js/function` 等の unsafe タグはパース時に throw する想定（`tests/frontmatter.test.ts` で検証済）。

## OS依存・ホスト依存の分離規約（2026-08-23 リファクタ）

- **`process.platform` / `win32` の分岐を書けるのは [packages/core/src/platform.ts](packages/core/src/platform.ts) だけ**（テストのスキップ条件と、telemetry 用の値変換 `normalizeOs` は除く）。owner-only 所有判定・PowerShell call prefix・node 実行ファイル名・パス case 正規化はここの関数を使う。全関数は `platform` を引数で受けてテスト可能
- **Claude / Codex 両インストーラの共通ヘルパは [apps/cli/src/installShared.ts](apps/cli/src/installShared.ts)**（`quoteIfSpaces` / `commandTokens` / `isCanonicalAsset` / backup 付き書込）。claudeInstall / codexHookInstall に残るのは「そのホストの設定ファイル形式と command の形」だけ
- **hook のベンダー中立エンジンは [apps/cli/src/hookShared.ts](apps/cli/src/hookShared.ts)**。`HookHost` 設定（agent / stderrTag / errorCode / stop-state dir / dedupe key）で Claude / Codex を切り替え、stdin 処理・DB 検索（markHit / query-miss log 込み）・pending drain / compact・stop 重複抑止を 1 実装で共有する。hookCmd / codexHookCmd に残るのは出力形式（`<system-reminder>` vs JSON）・payload 解釈・reminder 本文組み立て・worker 方式だけ
- 片方のホスト / OS を直す時は、共有モジュール側を直せば両方に効く。共有モジュールを迂回して cmd ファイルに同種ロジックを再複製しない

## Import 規約

- ESM、tsconfig は `"module": "NodeNext"`。**ソース間の相対 import は `.ts` ファイルでも `.js` 拡張子を書く**（例: `import { parseMarkdown } from './frontmatter.js'`）。vitest/vite と tsup の双方で正しく解決される。
- `@caveat/core` の公開 API は `packages/core/src/index.ts` 経由。
- ランタイムアセット（`schema.sql`, `migrations/`）は `db.ts` から `fileURLToPath(import.meta.url)` で相対解決。`tsup.config.ts` の onSuccess でビルド時に `dist/` へコピー。

## ロギング

MCP stdio サーバは stdout に JSON-RPC 以外を書いてはいけない。`packages/core/src/db.ts` は `stderrLogger` を export しているのでこれを使う。CLI プロセスでは stdout で可（`apps/cli/src/logger.ts` の `stdoutLogger`）。プロセスのエントリで適切なロガーを注入する。

## CLI の構造（Phase 3 / Phase 12 で拡張）

- コマンドは `apps/cli/src/commands/<name>.ts` に 1 ファイル 1 コマンド。`CliContext`（`context.ts`）経由で `caveatHome` / `userHome` / `config` / `paths` / `logger` を注入
- **`buildContext(logger, { caveatHome?, userHome? })`** — テストで `caveatHome` と `userHome` を override して一時ディレクトリに閉じる。本番実行では override なしで `findCaveatHome(userHome)`（`CAVEAT_HOME` env か `~/.caveat`）と `homedir()` を使う
- Phase 12 で追加されたサブコマンド:
  - `caveat mcp-server` — `@caveat/mcp` の `startMcpStdioServer()` を呼ぶ。Claude Code から spawn される
  - `caveat hook <user-prompt-submit|stop>` — `@caveat/core` の `claudeHooks.ts` を使って stdin JSON を読み、該当時のみ `<system-reminder>` を stdout に出す
  - `caveat init [--skip-claude] [--dry-run]` — Claude Code に MCP + hooks を登録（詳細下）
  - `caveat uninstall [--dry-run]` — 登録を解除
- v0.11 で追加されたサブコマンド:
  - `caveat stale [--days N] [--visibility public|private] [--limit N]` — 最後に検索で拾われてから N 日（default 90）経ったエントリを一覧。埋もれた private の月次点検用途
- **`paths.ts` / `config.ts` は `packages/core`**。`import { findCaveatHome, loadConfig, resolvePaths, ... } from '@caveat/core'`（旧 `findToolRoot` / `loadConfigFromPaths` は削除済）
- **default 設定は `packages/core/src/config.ts` 内の `DEFAULT_CONFIG` 定数**。`config/default.json` は Phase 12 で削除。`knowledgeRepo` default は `'own'`（caveatHome 相対）

## community 取り込み（Phase 8）

- [packages/core/src/community.ts](packages/core/src/community.ts) に全ロジック集約。CLI と Web UI から共用
- **URL validation**: `^https://github\.com/<org>/<repo>(\.git)?\/?$` 固定、gitlab・ssh・http は拒否。v1 は GitHub 限定
- **handle 抽出**: URL の repo 名部分。`.git` サフィクスと末尾スラッシュを除去。衝突時は `-2, -3, ...` で一意化（`caveat_record` の id slug と同じパターン）
- `caveat community add <url>` → `simpleGit().clone(url, target, ['--depth', '1'])` で shallow clone
- `caveat community pull` → `community/<handle>/` 各ディレクトリで `simpleGit(path).pull()`。失敗は `{ status: 'failed', message }` で収集（途中で落とさない）
- `caveat community list` → DB の `source = 'community/<handle>'` カウントと合わせて表示
- **community 取り込みと index は別コマンド**: add/pull した後は明示的に `caveat index` を呼んで FTS 同期する（01_plan.md の一方向フロー原則）

## Web の構造（Phase 5）

- [apps/web/src/routes/](apps/web/src/routes/) に 1 ルート 1 ファイル（`index.ts` = list + search / `detail.ts` = `/g/:id` / `community.ts` = community repo 一覧）
- [apps/web/src/app.ts](apps/web/src/app.ts) が Hono アプリを組み立て、[apps/web/src/server.ts](apps/web/src/server.ts) が `@hono/node-server` で listen する `startServer(opts)` を export
- [apps/web/src/wikilinks.ts](apps/web/src/wikilinks.ts) は markdown-it の **inline ルール拡張**（`md.inline.ruler.before('emphasis', 'wikilink', ...)`）。`[[slug]]` と `[[slug|label]]` を `<a href="/g/<encoded-slug>" class="wikilink">label</a>` に展開。外部 npm パッケージ非採用
- [apps/web/src/layout.ts](apps/web/src/layout.ts) に全 HTML と CSS。ビルドレス（no JSX、template literal）
- **read-only 原則**: `/new` や `/g/:id/edit` の書き込みエンドポイントは**持たない**。編集は Obsidian または md 直接編集 → `caveat index` で DB 同期
- CLI の `caveat serve --port 4242` が `@caveat/web` の `startServer` を直接呼ぶ（spawn ではなく同プロセス）

## MCP の構造（Phase 4）

- 6 tools が [apps/mcp/src/tools/](apps/mcp/src/tools/) に 1 ファイル 1 ツール（`search` / `get` / `record` / `update` / `listRecent` / `pull`）。v0.7 で `push` を削除、v0.6 で NLM 2 tools (`nlm_brief_for` / `ingest_research`) を `caveat_record` の薄いラッパとして削除済
- 各 tool ファイルは zod の `inputShape`（`ZodRawShape`）と `handleXxx(ctx, args)` を export
- [apps/mcp/src/registerTools.ts](apps/mcp/src/registerTools.ts) が `McpServer#registerTool` に全 tool を接続。戻り値は `JSON.stringify(data, null, 2)` を `content[0].text` で返す統一形
- [apps/mcp/src/server.ts](apps/mcp/src/server.ts) が stdio エントリ。`buildMcpContext()` で `stderrLogger` 注入（stdout は JSON-RPC 専用）。SIGINT/SIGTERM で `db.close()`
- **MCP の書き込み系ツール（`caveat_record` / `caveat_update`）は `@caveat/core` の `recordEntry` / `updateEntry` を呼ぶ**。core が md 書き出し + 同プロセス upsert を一体で行うので、直後の `caveat_search` で新規行が拾える
- **visibility の自動分類（v0.11）**: `caveat_record` / `caveat_update` の `visibility` は zod description の二項基準（第三者再現性）で Claude が自動判定する。v0.6.2 の「必ずユーザに聞け」は廃案。ユーザ明示依頼（「これは private で記録して」等）は自動判定に優先
- **visibility 3 択絞り込み（v0.11）**: `caveat_search` の `filters.visibility` に `'public' | 'private' | 'all'` を expose。省略時は全部。Hook 発の自動 surface はフラットのまま（絞らない）で、Claude が自発的に狙い撃ちしたい時のみ narrow する用途

## last_hit_at と caveat stale（v0.11、schema v2）

- `entries.last_hit_at TEXT`（nullable）を v2 で追加。検索で拾われるたびに ISO timestamp で UPDATE される
- **検索は pure、markHit で副作用分離**: [packages/core/src/markHit.ts](packages/core/src/markHit.ts) の `markHit(db, keys: Array<{id, source}>)` が時刻更新のみ担当。`search()` / `findCaveatsForPrompt()` 本体は副作用なし
- 呼び出し元: [apps/cli/src/commands/hookCmd.ts](apps/cli/src/commands/hookCmd.ts) の `searchCaveatsFromTextSafely` と [apps/mcp/src/tools/search.ts](apps/mcp/src/tools/search.ts) の `handleSearch` が検索結果が 0 件超の時のみ markHit を呼ぶ
- **migration 002**: 既存 v1 DB は `packages/core/src/migrations/002_last_hit_at.sql` の `ALTER TABLE entries ADD COLUMN last_hit_at TEXT` で自動 v2 化
- **`caveat stale` CLI**: [apps/cli/src/commands/stale.ts](apps/cli/src/commands/stale.ts) が `listStale(db, { days, visibility, limit })` を呼び出す。デフォルト 90 日、`--visibility private` で private だけに絞れる。月次点検で埋もれた private を発見する用途

## tsup / esbuild の罠

- **`packages/core` と `apps/mcp` は `bundle: false` + `entry: ['src/**/*.ts']`**。bundle すると esbuild が `node:` プレフィクスを dist 出力で剥がす（例: `from 'node:sqlite'` → `from 'sqlite'`）。`node:sqlite` は bare 名前では解決不能なので、consumer 側（vitest 4 / workspace 別パッケージ）で `Cannot find package 'sqlite'` として破綻する。bundle せずファイル個別出力にすれば保持される
- **`apps/cli` は Phase 12 で `bundle: true` + `noExternal` で workspace deps を吸収**。esbuild の prefix 剥がしは onSuccess の post-process で `NODE_BUILTINS` を regex 置換して復元。CJS 依存（gray-matter）は banner で `createRequire(import.meta.url)` を inject
- **`apps/cli` は workspace deps を「src ではなく各パッケージの `dist`」から bundle する**。`@caveat/core` と `@caveat/mcp` を直したら **core → mcp → cli の順で全部ビルドし直す**。`apps/mcp` の build を飛ばすと CLI は古い MCP を bundle し、typecheck も test も通るのに実行時だけ挙動が古いまま——という無症状の失敗になる（`corepack pnpm -r build` なら依存順で解決）。疑ったら `grep -c <新シンボル> apps/cli/dist/index.js` で bundle の実物を見る

## Claude Code 統合（Phase 10 で初期実装、Phase 12 でインストーラ化）

- **MCP サーバ**: `~/.claude.json`（`claude mcp add --scope user` で書き込み）。`~/.claude/settings.json` には書けない（schema validation で `mcpServers` フィールドが reject される）
- **Hooks**: `~/.claude/settings.json` の `hooks.UserPromptSubmit` / `hooks.PostToolUse` / `hooks.PostToolUseFailure` / `hooks.Stop` に throughline 等と並ぶ形で**既存エントリを保持したまま追記**
- **`caveat init`** ([apps/cli/src/claudeInstall.ts](apps/cli/src/claudeInstall.ts)) が自動で両方を設定:
  - MCP: `claude mcp remove` → `claude mcp add --scope user caveat -- <nodePath> --disable-warning=ExperimentalWarning <cliScriptPath> mcp-server`（idempotent）
  - Hooks: `settings.json` を read → `hooks.UserPromptSubmit` / `hooks.PostToolUse` / `hooks.PostToolUseFailure` / `hooks.Stop` に `node <cliScriptPath> hook <name>` を upsert → write（**書き込み前に `settings.json.caveat-backup-<ts>` を作成**）
  - `cliScriptPath` は `process.argv[1]`（NPM global install 時は `%AppData%/npm/node_modules/caveat-cli/dist/caveat.js`）
- **冪等性**: 既に同 command の hook エントリがあれば skip。重複追加しない
- **テスト**: `apps/cli/tests/claudeInstall.test.ts` — `skipMcpRegistration: true` で spawn を抑制し、settings.json merge のみテスト。実 `~/.claude.json` を汚染しない
- **uninstall**: `caveat uninstall` で MCP remove + hook エントリ削除。`--dry-run` で事前確認可
- **spawn 仕様**: `spawnSync(line, { shell: true })` で単一文字列を渡す（Node 24 の "shell + args array" deprecation 回避、Windows の `claude.cmd` も解決可能）

## Hook 規約

- **必ず `exit 0`**。stdin の JSON パースエラーでも exit 0 + stderr にログだけ。
- **stdout**: `<system-reminder>[caveat] ...</system-reminder>` を**発火時のみ**最大 1 ブロック出す。複数 pending reminder は 1 block 内で compact / dedupe して結合する。非発火時は**完全無音**（token 節約）。それ以外の文字は書かない。
- **stderr**: 診断情報のみ。
- 既存の `throughline` hook（UserPromptSubmit / Stop）と並走する前提。

### Claude Code Hook の実装（Phase 6 / Phase 12 / v0.8 / v0.12 / v0.13）

- **現行ロジック**: [packages/core/src/claudeHooks.ts](packages/core/src/claudeHooks.ts) に `extractPromptCandidates` / `findCaveatsForPrompt` / `findCaveatsForHook` / `defaultSelfIdentityTokens` / `userPromptSubmitReminderText(hits)` / `stopReminderText` を集約。`findCaveatsForPrompt` はUserPrompt互換、`findCaveatsForHook`は`topicText` / `failureText` / `surface`の出所を保持するhook専用入口。CLI サブコマンド `caveat hook <name>` ([apps/cli/src/commands/hookCmd.ts](apps/cli/src/commands/hookCmd.ts)) が stdin + caveatHome を組み合わせて DB を開き、結果を埋め込んだリマインダを stdout に出す。stdout は host contract に合わせ、Claude では最大 1 `<system-reminder>` block、Codex では単一 JSON object
- **事前発火（UserPromptSubmit）の判定**: プロンプトを token 列に分解 → 各 token を個別に FTS5 phrase 検索 → **3 段の構造的ゲートを全て通過した entry のみ** を hit とみなす:
  1. **共起ゲート**: 1 entry あたり ≥ 2 個の distinct prompt **グループ** (= 空白区切り source token、CJK 連続 run も 1 グループ) が一致
  2. **症状特異語ゲート (v0.12)**: マッチした prompt token のうち最低 1 つが entry の `symptom_text` に出現
  3. **rare topical-anchor ゲート (v0.14.2)**: `topical_text` に出現した prompt token のうち最低 1 つが「prompt 内で corpus DF が最小タイ」のもの
  
  hit ≥ 1 のときのみ発火、DB ヒットをそのままリマインダ本文に埋めるので、Claude が改めて `caveat_search` を呼ばずともコンテキストに関連罠が入る
- **Tokenize 規則** (`extractPromptCandidates` / `buildPromptCandidates` 内、v0.12 拡張):
  - **パス様部分文字列を最初に剥がす**: UNC (`\\\\host\\path`) / Windows drive (`C:\\path`) / POSIX abs (`/x/y/z`) を空白化。URL は preserve (`://` の `/` は whitespace 始まりじゃないので非マッチ)
  - 非英数・非 CJK 文字を空白に置換 → 空白 split
  - ASCII 単語は ≥ 3 文字のみ（`the` / `on` 等は自動脱落するが `make` / `new` / `what` は残す — 共起ルールで無害化）
  - CJK run は 3-char sliding window に展開（`初期化失敗` → `初期化`, `期化失`, `化失敗`）+ **純ひらがな trigram は drop** (`してる`, `のまま` 等は conjugational glue)
  - 同一 source token から派生した複数 trigram は **同じ group id を共有** (CJK 句単位 dedup)
  - Case-insensitive dedup → 先頭 50 token 上限
- **症状特異語 / rare topical-anchor の構造的根拠 (v0.12 / v0.14.2)**: 共起だけでは「固有名詞の偶然一致」を捕まえる (`RTX 5090` がたまたま 2 entry の title に出る → 2-of-N 成立)。これは「話題に触れただけ」であって「困っているか」「何が起きているか」までは何も言っていない。`## Symptom` セクションは entry 構造で「何がどう壊れるか」と定義されているので、**prompt と Symptom の重なりは「ユーザーがその失敗状態を述べている」ことの構造的根拠**。ただし長い症状文には「正常に動く」「誤発火」など会話断片も混ざるため、それだけで主題判定まで兼ねてはいけない。`topical_text` (title + tags + environment 値) は著者が能動的にキュレートした主題語なので、**rare anchor は topical_text 側で要求する**。これにより「何が壊れたか」と「何についての罠か」を両側独立に満たした時だけ発火する
- **共起ルールが `allowlist` / `stopword list` を代替する理由**: 旧設計は (a) keyword allowlist（Phase 6、罠ドメインを regex で列挙）→ recall 低い／メンテ永遠、(b) v0.8 初案の stopword list（`make` / `new` を hand-curate） → リスト化自体が構造欠陥、と辿った。2-of-N co-occurrence + 症状特異語 + rare topical-anchor は **全てリスト不要、閾値チューニング不要** (唯一の数値定数は 2-of-N の `2`)、Unicode 範囲・FTS5 仕様・`os.userInfo()`/`homedir()` runtime 値・corpus DF だけで判定。**「list で除外する」のではなく「構造で要求する」** が設計の肝
- **`defaultSelfIdentityTokens()` (v0.12)**: `os.userInfo().username` と `os.homedir()` の path 成分 (≥ 3 文字) を Set で返す runtime-derived 関数。CLI hook 呼び出し側が `findCaveatsForHook(..., { selfIdentity: defaultSelfIdentityTokens() })` へ渡す。**ツールブランド `caveat` は意図的に含めない** — ハードコードリスト化を避け、rare-anchor gate が「caveat は corpus 全域で高 DF」として構造的に弾くのに任せる
- **hookCmd の DB 接続**: `buildContext(silentLogger)` で caveatHome 解決 → `existsSync(ctx.paths.dbPath)` で DB 未作成時は即 silent（false-block 回避）→ `openDb` → `findCaveatsForHook` → 必ず `db.close()`
- **事後発火（Stop hook）の判定** (v0.9): `payload.transcript_path` の JSONL を `readSessionSignals` ([packages/core/src/transcriptSignals.ts](packages/core/src/transcriptSignals.ts)) で解析し、以下のシグナルを抽出:
  - `toolFailureCount`: `is_error: true` を返した tool_result の件数
  - `fileEditCounts`: Edit/Write/NotebookEdit の file_path 集計（count > 1 のみ）
  - `webSearchCount` / `webFetchCount`: 外部仕様調査の跡
  - `bashRetryCount`: 同一 Bash コマンドを複数回実行した種類数（失敗 → 修正 → 再実行 パターン）
  - `durationMinutes`: first / last timestamp から算出（発火ゲートには使わない、表示のみ）
  - `errorSnippets` / `searchQueries`: リマインダ本文 & FTS 用の raw text
- **発火ゲート**: `hasAnyStruggleSignal(s)` = 上記 count のいずれか > 0 or fileEditCounts.length > 0。**閾値チューニング無し**の構造的 or 判定（「0 か 1 以上か」のみ）。tool failure 無・編集 1 回だけ・web 検索無しなら完全無音 → 単純編集セッションでリマインダ洪水を起こさない
- **stop リマインダ本文**: シグナル具体数値を列挙（Y）。既存罠の候補化は各`errorSnippet`を独立した`surface: stop`入力として`findCaveatsForHookSegments`へ渡し、session内の別時点の`searchQueries`や別errorとの語の足し算では発火させない。`searchQueries`はreminder/advisoryの構造化文脈にだけ残す。既存罠に類似があれば`caveat_update`を、なければ`caveat_record`を促す（Z）。Stop hook 自体は stdout に出さず、session pending queue に積んで次の `UserPromptSubmit` / `PostToolUse` で表示する。同一 session / 同一 signal digest は再 enqueue しない
- **Codex sidecar advisory (v0.13)**: `Stop` hook が発火した場合、`CAVEAT_HOOK_CODEX_SIDECAR` が `auto` / `require` なら `caveat codex-sidecar run explore` を同期的に呼び、既存 `stopReminderText` の後ろへ Codex の助言を追記して pending に積む。`auto` は project root に `.codex-sidecar.yml` がある時だけ試す。`off` は pre-v0.13 と同じ本文のみ。失敗時は hidden fallback せず unavailable 行を出す
- **Codex CLI の解決順 (codex-sidecar 側設計)**: codex-sidecar は実行時に `process.env.CODEX_BINARY ?? "codex"` で Codex CLI を解決する。`CODEX_BINARY` が立っていればそのパスを、無ければ PATH 上の `codex` を `spawn` する。**Caveat 側は `caveat init` でこの env を一切書き込まない** — 一般ユーザは `npm install -g @openai/codex` で `codex` を PATH に乗せていれば追加設定不要。VS Code 拡張内のバイナリしか手元に無い等で PATH に乗らない環境のみ、ユーザが自力で `~/.claude/settings.json` のフック行に env プレフィックスを足す必要がある。VS Code 拡張のディレクトリ名はバージョン番号入りで更新ごとに変わるため、絶対パスを書くと拡張更新で advisory が ENOENT で死ぬ。基本は PATH 解決に倒す
- **再帰防止**: `payload.stop_hook_active === true` の場合は stdout 空で即 exit（不変）
- **実行中発火（PostToolUse / PostToolUseFailure hook、v0.10 / v0.14）— 非同期パイプライン**:
  - Claude Code は tool 呼び出し後に PostToolUse 系 hook を同期的に呼び出し、その stdout を次ターンのコンテキストに挿入する。現行 Claude Code の失敗 tool は `PostToolUseFailure` として発火し、payload の `error` field に失敗内容を入れる。成功/通常系互換のため `PostToolUse` も維持する。同期的に FTS を走らせると tool ごとに 150-300ms のレイテンシが乗るので、**前景 hook は drain + worker spawn で ~20ms 返す**。
  - 前景フロー: (1) `drainPendingReminders(caveatHome, sessionId)` で過去 worker / Stop が書いた reminder ファイルを読み、dedupe + 上限で compact して最大 1 `<system-reminder>` として stdout に emit → unlink / (2) `tool_response.is_error === true` または `hook_event_name === 'PostToolUseFailure'` / `error` field があるときのみ、allowlistしたtool名・command/queryを`topicText`、失敗本文を`failureText`としてv2 work fileへ分離保存し、`spawn(node, [cli, 'hook', 'worker', workFile], {detached:true,stdio:'ignore'}).unref()` で detached worker を起動し即 exit
  - 非同期 worker (`caveat hook worker <workFile>`): work file を読んで unlink → `findCaveatsForHook(db, { topicText, failureText, surface: 'tool_error' })` を走らせる。主題anchorは両field、症状根拠は`failureText`だけから採る。hit > 0 なら`toolErrorReminderText(hits)`をpendingへ積み、v0.13以降はsidecarが使える時だけCodex advisoryを末尾へ追記する
  - drain は **UserPromptSubmit / PostToolUse の最初で実行**。Stop hook は final answer 直後の stdout 表示を避けるため drain せず、Stop reminder を pending に積むだけにする
  - pending ファイルはセッション id でディレクトリ分離 ([packages/core/src/pendingReminders.ts](packages/core/src/pendingReminders.ts))。`session_id` は `[^A-Za-z0-9_-]` を strip してサニタイズ、traversal 攻撃を防ぐ
  - 結果として reminder は **エラー発生の次の hook tick で Claude のコンテキストに載る**（最短で次の tool 呼び出し、最悪でも user prompt 直前）。Claude は新しいエラーを見る前後のタイミングで「このエラーは既知罠 XYZ」を認識できる
  - セッション跨ぎの pending 蓄積掃除: [packages/core/src/pendingReminders.ts](packages/core/src/pendingReminders.ts) に 2 段の API を持つ。`cleanupStalePendingDirs(caveatHome, { staleDays })` は `<caveatHome>/pending/<sessionId>/` のうち**そのサブツリー内 (ディレクトリ自身 + 残存 .txt) の最新 mtime が `staleDays` 日以上前**のものを丸ごと削除する純粋関数 (default 7 日、`staleDays=0` は「現在より過去のもの全部」)。drain で空になった殻も、放棄されてファイルが残った墓も同条件で扱う。アクティブセッションは append/drain で mtime が更新され続けるので回収されない。`maybeSweepPendingDirs(caveatHome, { staleDays, debounceDays })` はホットパスから呼ぶデバウンス付きラッパで、`<caveatHome>/pending/.last-sweep` マーカーの mtime を見て `debounceDays` (default 1) 以内なら即 return、初回または期限切れなら `cleanupStalePendingDirs` を呼んでマーカーを更新する。`CAVEAT_PENDING_SWEEP=off` で完全無効化可 (マーカーも触らない)。発火点は 2 つ: (a) `caveat hook stop` 冒頭で `maybeSweepPendingDirs(ctx.caveatHome)` を try/catch で呼ぶ — グローバル install 後ほぼ走らない `caveat init` に依存せず、Stop hook が定期掃除を担う。(b) `caveat init` が belt-and-suspenders で `cleanupStalePendingDirs` を呼ぶ (CLI フラグ `--pending-stale-days <n>` で `staleDays` 上書き可、dry-run 時は予告ログのみ)
- **Phase 6 の legacy `.mjs` ファイル**（`hooks/user-prompt-submit.mjs` と `hooks/stop.mjs`）は v0.11.2 で削除済。NPM 配布した `caveat` コマンド経由では `caveat hook <name>` の新経路だけが使われるため、旧キーワード allowlist 実装の dev-mode 参照は不要になった。`hooks/pre-commit-visibility-gate.mjs` は `.husky/pre-commit` から exec される現役のため残置

### Git pre-commit visibility gate（Phase 7）

- [.husky/pre-commit](.husky/pre-commit) — Husky 9 が `core.hooksPath=.husky` を設定すれば git commit 時に自動発火。内容は `hooks/pre-commit-visibility-gate.mjs` を exec するだけの 1 行
- [hooks/pre-commit-visibility-gate.mjs](hooks/pre-commit-visibility-gate.mjs) — staged `entries/**/*.md` を `git diff --cached --diff-filter=ACMR` で列挙、`git show :<path>` で index 版（working tree でなく）を取得、`@caveat/core` の `findBlockedFiles`（内部で `parseMarkdown`）で frontmatter を解析、`visibility: private` があれば blocked 一覧 + 修正案を stderr に出して exit 1
- **非 git ディレクトリや staged 対象なしは exit 0**。false-block を回避（`feedback_no_unnecessary_fallbacks` の範囲内、必要最小のガード）
- 緊急バイパスは `git commit --no-verify`（git 標準）。カスタム escape hatch は作らない
- `findBlockedFiles(stagedContents)` は v0.11.2 で `@caveat/core/visibilityGate` に移動済。`hooks/pre-commit-visibility-gate.mjs` は core から import して re-export する薄いラッパ。test (`hooks/tests/pre-commit-gate.test.ts`) も `@caveat/core` から import するので、`.mjs` を vitest が直接 transform する経路を取らない（Windows + vitest で日本語含む `.mjs` の transform が `SyntaxError: Invalid or unexpected token` で落ちる CI 問題の構造的回避）

## 自動同期（AutoSync）

**多端末伝播の唯一の経路**。ロジックは [packages/core/src/autoSync.ts](packages/core/src/autoSync.ts) に集約。

- **1 cycle の中身**: `communityPull`（全 community repo を git pull）→ `syncOwn`（commit → `pull --rebase` → push）→ 全 source 再索引。**push と pull は分離できない** — `syncOwn` が必ず往復する 1 セット。前段に匿名可読 probe（remote への HTTP GET）が入る。実測 ~3.5s（community 0 件、own 218 entries、detached background なのでユーザー体感 0）
- **発火点は 2 つ**。どちらも `triggerAutoSync` で detached worker (`caveat hook autosync`) を spawn して即 return する:
  1. **Stop hook** ([hookCmd.ts](apps/cli/src/commands/hookCmd.ts) / [codexHookCmd.ts](apps/cli/src/commands/codexHookCmd.ts)) — `AUTO_SYNC_DEBOUNCE_MS` = **15 分**。定期的に他端末の entry を拾う担当
  2. **MCP の書き込み** (`caveat_record` / `caveat_update`) — `AUTO_SYNC_RECORD_DEBOUNCE_MS` = **60 秒**。登録した罠を即座に private remote へ出す担当。`McpContext.onEntryWritten` 経由（**必須フィールド**。テストが暗黙に実 spawn するのを型で防ぐため optional にしない）
- **デバウンス値の根拠**: 旧 24 時間は送信側・受信側の両方に掛かり、伝播が最悪 48h だった。「別端末で登録した罠が当日中に届かない」は Caveat の価値そのものを殺すので、実測コストが許す範囲まで詰めた。record 起点の 60 秒は rate limit ではなく **burst 吸収の floor**
- **失敗時は backoff であって永久停止ではない**: 同一 code の失敗が `AUTO_SYNC_SUSPEND_THRESHOLD`(3) 回連続すると `AUTO_SYNC_DEGRADED_RETRY_MS`(6h) 間隔へ後退する。**手動 `caveat sync` を待たずに自力で回復する**。degraded 中は `AUTO_SYNC_NOTICE_REPEAT_MS`(24h) ごとに reminder を再送する（旧実装は escalation を 1 回告知した後は完全に無言で永久停止し、伝播が死んだことに誰も気づけなかった）
- **notification signature は「本文」から採る**。`sha256(JSON.stringify(lines))` のみ。内部 field (`disposition` / `suspended`) を混ぜると、同じ意味の状態（6h ごとの再試行失敗 と その間の skip）が別物と判定されて backoff 窓ごとに 2 通飛ぶ
- **env**: `CAVEAT_AUTO_SYNC=off` で全停止。`CAVEAT_AUTO_SYNC_DEBOUNCE_MS` でデバウンス上書き（**不正値は stderr に警告して default へ落とす** — `Number('abc')` = NaN、`elapsed < NaN` は常に false なので、素通しにすると「毎回 spawn」になる）
- **配布の注意**: 伝播は両端末が新版を持って初めて速くなる。片側だけ更新しても、相手が push しなければ pull するものが無い
