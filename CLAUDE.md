# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクトの状態

**v0.6.1**（2026-04-19、136 tests passing）。tool 本体 + 共有ナレッジ DB を本 repo に統合し、[caveat-cli](https://www.npmjs.com/package/caveat-cli) として NPM に publish 済。`npm i -g caveat-cli && caveat init` でユーザは自動で共有 DB を購読、`caveat push <id>` で PR を投げ、`caveat pull` でマージ済の他人の貢献を取り込める。MCP tool は 7 種（search/get/record/update/list_recent/pull/push）— v0.6 で NLM 2 tools（`nlm_brief_for` / `ingest_research`）を `caveat_record` の薄いラッパとして削除。

**GitHub に push 済**:
- Tool (public): https://github.com/kitepon-rgb/Caveat
- v0.5 で tool + 共有ナレッジ DB を [kitepon-rgb/Caveat](https://github.com/kitepon-rgb/Caveat) に統合（`entries/` がこの repo 内）。旧 `kitepon-rgb/caveats-quo` は削除済

**`docs/plan.md` が設計の真実の源**。アーキテクチャ判断の前に必ず読む。`docs/audit.md` には過去に議論・却下した論点が残っているので蒸し返さない。`docs/archive/` には没案や別セッション由来の設計メモが置いてある（現役資料ではない）。

## コマンド

`pnpm` は PATH に無く、`corepack pnpm` 経由で実行（pnpm 10.0.0 が `packageManager` で pin）。pnpm 10 はビルドスクリプトをデフォルトブロック、ホワイトリストは root `package.json` の `pnpm.onlyBuiltDependencies`。

`pnpm` は PATH に無く、`corepack pnpm` 経由で実行（pnpm 10.0.0 が `packageManager` で pin）。CLI パッケージ名は `caveat-cli`（bin は `caveat`）、他の workspace パッケージは `@caveat/core` / `@caveat/mcp` / `@caveat/web`。

```sh
corepack pnpm install                              # workspace 依存をインストール
corepack pnpm --filter @caveat/core test           # core tests（84 tests）
corepack pnpm --filter @caveat/core build          # tsup + schema.sql / migrations を dist へコピー
corepack pnpm --filter caveat-cli test             # CLI smoke + installer tests（10 tests）
corepack pnpm --filter caveat-cli build            # CLI ビルド（bundle + workspace deps noExternal + dist/caveat.js 生成）
corepack pnpm --filter @caveat/mcp test            # MCP tool-handler tests（10 tests）
corepack pnpm --filter @caveat/web test            # Web tests（13 tests）
corepack pnpm -r build                             # 全 workspace パッケージをビルド

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
- **`paths.ts` / `config.ts` は `packages/core`**。`import { findCaveatHome, loadConfig, resolvePaths, ... } from '@caveat/core'`（旧 `findToolRoot` / `loadConfigFromPaths` は削除済）
- **default 設定は `packages/core/src/config.ts` 内の `DEFAULT_CONFIG` 定数**。`config/default.json` は Phase 12 で削除。`knowledgeRepo` default は `'own'`（caveatHome 相対）

## community 取り込み（Phase 8）

- [packages/core/src/community.ts](packages/core/src/community.ts) に全ロジック集約。CLI と Web UI から共用
- **URL validation**: `^https://github\.com/<org>/<repo>(\.git)?\/?$` 固定、gitlab・ssh・http は拒否。v1 は GitHub 限定
- **handle 抽出**: URL の repo 名部分。`.git` サフィクスと末尾スラッシュを除去。衝突時は `-2, -3, ...` で一意化（`caveat_record` の id slug と同じパターン）
- `caveat community add <url>` → `simpleGit().clone(url, target, ['--depth', '1'])` で shallow clone
- `caveat community pull` → `community/<handle>/` 各ディレクトリで `simpleGit(path).pull()`。失敗は `{ status: 'failed', message }` で収集（途中で落とさない）
- `caveat community list` → DB の `source = 'community/<handle>'` カウントと合わせて表示
- **community 取り込みと index は別コマンド**: add/pull した後は明示的に `caveat index` を呼んで FTS 同期する（plan.md の一方向フロー原則）

## Web の構造（Phase 5）

- [apps/web/src/routes/](apps/web/src/routes/) に 1 ルート 1 ファイル（`index.ts` = list + search / `detail.ts` = `/g/:id` / `community.ts` = community repo 一覧）
- [apps/web/src/app.ts](apps/web/src/app.ts) が Hono アプリを組み立て、[apps/web/src/server.ts](apps/web/src/server.ts) が `@hono/node-server` で listen する `startServer(opts)` を export
- [apps/web/src/wikilinks.ts](apps/web/src/wikilinks.ts) は markdown-it の **inline ルール拡張**（`md.inline.ruler.before('emphasis', 'wikilink', ...)`）。`[[slug]]` と `[[slug|label]]` を `<a href="/g/<encoded-slug>" class="wikilink">label</a>` に展開。外部 npm パッケージ非採用
- [apps/web/src/layout.ts](apps/web/src/layout.ts) に全 HTML と CSS。ビルドレス（no JSX、template literal）
- **read-only 原則**: `/new` や `/g/:id/edit` の書き込みエンドポイントは**持たない**。編集は Obsidian または md 直接編集 → `caveat index` で DB 同期
- CLI の `caveat serve --port 4242` が `@caveat/web` の `startServer` を直接呼ぶ（spawn ではなく同プロセス）

## MCP の構造（Phase 4）

- 7 tools が [apps/mcp/src/tools/](apps/mcp/src/tools/) に 1 ファイル 1 ツール（`search` / `get` / `record` / `update` / `listRecent` / `nlmBriefFor` / `ingestResearch`）
- 各 tool ファイルは zod の `inputShape`（`ZodRawShape`）と `handleXxx(ctx, args)` を export
- [apps/mcp/src/registerTools.ts](apps/mcp/src/registerTools.ts) が `McpServer#registerTool` に全 tool を接続。戻り値は `JSON.stringify(data, null, 2)` を `content[0].text` で返す統一形
- [apps/mcp/src/server.ts](apps/mcp/src/server.ts) が stdio エントリ。`buildMcpContext()` で `stderrLogger` 注入（stdout は JSON-RPC 専用）。SIGINT/SIGTERM で `db.close()`
- **MCP の書き込み系ツール（`caveat_record` / `caveat_update` / `ingest_research`）は `@caveat/core` の `recordEntry` / `updateEntry` を呼ぶ**。core が md 書き出し + 同プロセス upsert を一体で行うので、直後の `caveat_search` で新規行が拾える

## tsup / esbuild の罠

- **`packages/core` と `apps/mcp` は `bundle: false` + `entry: ['src/**/*.ts']`**。bundle すると esbuild が `node:` プレフィクスを dist 出力で剥がす（例: `from 'node:sqlite'` → `from 'sqlite'`）。`node:sqlite` は bare 名前では解決不能なので、consumer 側（vitest 4 / workspace 別パッケージ）で `Cannot find package 'sqlite'` として破綻する。bundle せずファイル個別出力にすれば保持される
- **`apps/cli` は Phase 12 で `bundle: true` + `noExternal` で workspace deps を吸収**。esbuild の prefix 剥がしは onSuccess の post-process で `NODE_BUILTINS` を regex 置換して復元。CJS 依存（gray-matter）は banner で `createRequire(import.meta.url)` を inject

## Claude Code 統合（Phase 10 で初期実装、Phase 12 でインストーラ化）

- **MCP サーバ**: `~/.claude.json`（`claude mcp add --scope user` で書き込み）。`~/.claude/settings.json` には書けない（schema validation で `mcpServers` フィールドが reject される）
- **Hooks**: `~/.claude/settings.json` の `hooks.UserPromptSubmit` と `hooks.Stop` に throughline 等と並ぶ形で**既存エントリを保持したまま追記**
- **`caveat init`** ([apps/cli/src/claudeInstall.ts](apps/cli/src/claudeInstall.ts)) が自動で両方を設定:
  - MCP: `claude mcp remove` → `claude mcp add --scope user caveat -- <nodePath> --disable-warning=ExperimentalWarning <cliScriptPath> mcp-server`（idempotent）
  - Hooks: `settings.json` を read → `hooks.UserPromptSubmit` と `hooks.Stop` に `node <cliScriptPath> hook <name>` を upsert → write（**書き込み前に `settings.json.caveat-backup-<ts>` を作成**）
  - `cliScriptPath` は `process.argv[1]`（NPM global install 時は `%AppData%/npm/node_modules/caveat-cli/dist/caveat.js`）
- **冪等性**: 既に同 command の hook エントリがあれば skip。重複追加しない
- **テスト**: `apps/cli/tests/claudeInstall.test.ts` — `skipMcpRegistration: true` で spawn を抑制し、settings.json merge のみテスト。実 `~/.claude.json` を汚染しない
- **uninstall**: `caveat uninstall` で MCP remove + hook エントリ削除。`--dry-run` で事前確認可
- **spawn 仕様**: `spawnSync(line, { shell: true })` で単一文字列を渡す（Node 24 の "shell + args array" deprecation 回避、Windows の `claude.cmd` も解決可能）

## Hook 規約

- **必ず `exit 0`**。stdin の JSON パースエラーでも exit 0 + stderr にログだけ。
- **stdout**: `<system-reminder>[caveat] ...</system-reminder>` を**発火時のみ** 1 ブロック出す。非発火時は**完全無音**（token 節約）。それ以外の文字は書かない。
- **stderr**: 診断情報のみ。
- 既存の `throughline` hook（UserPromptSubmit / Stop）と並走する前提。

### Claude Code Hook の実装（Phase 6 / Phase 12）

- **Phase 12 現行ロジック**: [packages/core/src/claudeHooks.ts](packages/core/src/claudeHooks.ts) に `detectCaveatTrigger` / `userPromptSubmitReminderText` / `stopReminderText` を集約。CLI サブコマンド `caveat hook <name>` ([apps/cli/src/commands/hookCmd.ts](apps/cli/src/commands/hookCmd.ts)) が stdin を読んで呼ぶ
- **トリガ**: プロンプトに GPU/driver/CUDA/nvidia/AMD/RTX/VSCode/Claude Code/flaky/再現しない/バージョン依存/native module 等のキーワードが含まれたら発火。`CAVEAT_TRIGGERS` 配列で管理
- **stop hook**: 無条件で発火、ただし `payload.stop_hook_active === true` の場合は stdout 空（再帰防止）。メッセージは「解決した罠だけでなく `outcome: impossible` の結論も記録対象」を含む
- **Phase 6 の legacy `.mjs` ファイル** ([hooks/user-prompt-submit.mjs](hooks/user-prompt-submit.mjs) / [hooks/stop.mjs](hooks/stop.mjs)) は dev-mode での動作確認と spawn テスト用に残している。NPM 配布した `caveat` コマンド経由では使われない

### Git pre-commit visibility gate（Phase 7）

- [.husky/pre-commit](.husky/pre-commit) — Husky 9 が `core.hooksPath=.husky` を設定すれば git commit 時に自動発火。内容は `hooks/pre-commit-visibility-gate.mjs` を exec するだけの 1 行
- [hooks/pre-commit-visibility-gate.mjs](hooks/pre-commit-visibility-gate.mjs) — staged `entries/**/*.md` を `git diff --cached --diff-filter=ACMR` で列挙、`git show :<path>` で index 版（working tree でなく）を取得、`@caveat/core` の `parseMarkdown` で frontmatter 解析、`visibility: private` があれば blocked 一覧 + 修正案を stderr に出して exit 1
- **非 git ディレクトリや staged 対象なしは exit 0**。false-block を回避（`feedback_no_unnecessary_fallbacks` の範囲内、必要最小のガード）
- 緊急バイパスは `git commit --no-verify`（git 標準）。カスタム escape hatch は作らない
- `findBlockedFiles(stagedContents)` を export して unit テスト可能にしてある
