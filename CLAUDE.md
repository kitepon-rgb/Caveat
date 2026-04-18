# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクトの状態

Pre-alpha。Phase 10/11 完了（Claude Code 統合 wire-up 済、MCP 接続と hooks 発火を実機確認）（[docs/plan.md](docs/plan.md) の「実装フェーズ」節を参照）。設計は 5 ラウンドの監査を経て収束済み。設計変更時は `docs/plan.md` を更新し、`docs/audit.md` に記録されたパターンで再監査する。

**GitHub に push 済**:
- Tool (public): https://github.com/kitepon-rgb/Caveat
- Knowledge (private): https://github.com/kitepon-rgb/caveats-quo

**`docs/plan.md` が設計の真実の源**。アーキテクチャ判断の前に必ず読む。`docs/audit.md` には過去に議論・却下した論点が残っているので蒸し返さない。`docs/archive/` には没案や別セッション由来の設計メモが置いてある（現役資料ではない）。

## コマンド

`pnpm` は PATH に無く、`corepack pnpm` 経由で実行（pnpm 10.0.0 が `packageManager` で pin）。pnpm 10 はビルドスクリプトをデフォルトブロック、ホワイトリストは root `package.json` の `pnpm.onlyBuiltDependencies`。

```sh
corepack pnpm install                              # workspace 依存をインストール
corepack pnpm --filter @caveat/core test           # core の全テスト（vitest run）
corepack pnpm --filter @caveat/core test -- <pat>  # vitest のパターンフィルタ
corepack pnpm --filter @caveat/core typecheck      # tsc --noEmit
corepack pnpm --filter @caveat/core build          # tsup + schema.sql / migrations を dist へコピー
corepack pnpm --filter @caveat/cli test            # CLI smoke tests（4 tests）
corepack pnpm --filter @caveat/cli build           # CLI ビルド（bundle あり、dist/index.js）
corepack pnpm --filter @caveat/mcp test            # MCP tool-handler tests（10 tests）
corepack pnpm --filter @caveat/mcp build           # MCP サーバビルド
corepack pnpm --filter @caveat/web test            # Web tests（13 tests）
corepack pnpm --filter @caveat/web build           # Web ビルド
corepack pnpm -r build                             # 全 workspace パッケージをビルド
node apps/cli/dist/index.js <subcommand>           # ビルド後の CLI 実行
node apps/cli/dist/index.js serve --port 4242      # Web ポータル起動（read-only 共有）
node apps/mcp/dist/server.js                       # MCP stdio サーバ起動（Claude Code から呼ばれる）
```

単一テストファイル: `corepack pnpm --filter @caveat/core test -- tests/env.test.ts`
単一 describe/it: `corepack pnpm --filter @caveat/core test -- -t "envMatch"`

## アーキテクチャ

**`markdown-in-git` が真実の源**。SQLite は再構築可能な派生 FTS5 インデックスで `.index/caveat.db`（gitignore）。SQLite DB を権威扱いしない — 必ず markdown から再生成できる状態を保つ。

**2 repo 分離**: 本 repo は tool（`Caveat`）。knowledge repo（例: `caveats-quo`）は別 repo で、`config/default.json` に相対パスで参照、`~/.caveatrc.json` で上書き可能。個人の絶対パスを tool repo に書かない。

**source 名前空間**: 全行が `source ∈ {'own', 'community/<handle>'}` を持つ。PK は `(source, id)` 複合 — community 取り込みで `own` と衝突しないための必須条件。`packages/core/src/schema.sql` 参照。

**FTS5 はトリガ経由で同期**: `entries_fts` は `entries.rowid` に対する external-content。`schema.sql` の 3 トリガ（ai/ad/au）が FTS を同期する。インデクサコードは `entries_fts` を直接触らない — `entries` への UPDATE/INSERT/DELETE のみ。

**インデクサの意味論**: `scanSource(db, source, entriesRoot)` は 1 source ずつ走査し、タッチした rowid の TEMP table を経由して**その source 内の**未タッチ行のみ削除する。全 source を 1 パスで走査すると他 source を巻き込んで削除するので絶対にしない。

**単一ファイル upsert 経路**: `upsertEntry(db, row)` は `caveat_record` / `caveat_update` の md 書き込み後に同期呼びする。MCP ツールは必ず同一プロセスで同期呼びしないと、直後の `caveat_search` で新規行が拾えない。

## FTS5 クエリのサニタイズ（Phase 9 で追加）

- `repository.ts` の `search()` は内部で `sanitizeFtsQuery` を呼び、user-provided query の**非英数・非 CJK 文字を空白に置換してから各トークンを `"..."` で quote** する
- これで `node:sqlite` / `node.js` / `a+b*c` 等の FTS5 operator に該当する文字を含むクエリでも死なない
- 代償: FTS5 の高度な演算子（`NEAR`, `OR`, `-negative` 等）は使えない。v1 は全部シンプルな phrase AND 扱い
- 必要になったら `search({ query, raw: true })` を追加して生クエリパスを開ける（v1 には入れない）

## スタック固有の罠（Phase 2/3 で検証済）

- **DB は `node:sqlite`（builtin、Node 22.5+）** — `better-sqlite3` ではない。MSVC の無い Windows ではネイティブビルド不能、かつ `better-sqlite3` 12.x は Node 24 prebuild 未提供。`node:sqlite` はプロセスごとに `ExperimentalWarning` を 1 回出す（stderr、1 行）。CLI は現状このまま通す（Phase 3 では無害と判断）。MCP サーバは stdout に JSON-RPC 以外を書けないので Phase 4 で spawn 時に `--disable-warning=ExperimentalWarning` を付与する。ESM の import hoisting により `process.on('warning', ...)` ランタイム登録では間に合わないため、bootstrap 経由の runtime 抑制はしない。
- **`packages/core` は `tsup` を `bundle: false` で使う**。単一バンドルを出すと esbuild が dist 出力時に `node:` プレフィクスを剥がす（例: `from 'node:sqlite'` → `from 'sqlite'`）。bundle せず `entry: ['src/**/*.ts']` でファイル個別出力にすると prefix が保持される。core テストは src 直接参照で通るため Phase 2 では発覚せず、CLI が dist 経由で core を import した段階で `Cannot find package 'sqlite'` として表面化した。
- **vitest 4 + vite 7 必須**。vitest 2 + vite 5 は `node:sqlite` の import を解決できない（`node:` プレフィクスを剥がす）。
- **FTS5 trigram は 3 文字以上のクエリが必要**。日本語 2 文字（例: `仕様`）はヒットしない。ドキュメント化済の仕様なので、クエリの事前バリデーションは足さない。
- **gray-matter の YAML エンジン**は `jsyaml.JSON_SCHEMA` に固定。`!!js/function` 等の unsafe タグはパース時に throw する想定（`tests/frontmatter.test.ts` で検証済）。

## Import 規約

- ESM、tsconfig は `"module": "NodeNext"`。**ソース間の相対 import は `.ts` ファイルでも `.js` 拡張子を書く**（例: `import { parseMarkdown } from './frontmatter.js'`）。vitest/vite と tsup の双方で正しく解決される。
- `@caveat/core` の公開 API は `packages/core/src/index.ts` 経由。
- ランタイムアセット（`schema.sql`, `migrations/`）は `db.ts` から `fileURLToPath(import.meta.url)` で相対解決。`tsup.config.ts` の onSuccess でビルド時に `dist/` へコピー。

## ロギング

MCP stdio サーバは stdout に JSON-RPC 以外を書いてはいけない。`packages/core/src/db.ts` は `stderrLogger` を export しているのでこれを使う。CLI プロセスでは stdout で可（`apps/cli/src/logger.ts` の `stdoutLogger`）。プロセスのエントリで適切なロガーを注入する。

## CLI の構造（Phase 3）

- コマンドは `apps/cli/src/commands/<name>.ts` に 1 ファイル 1 コマンド。`CliContext`（`context.ts`）経由で `toolRoot` / `userHome` / `config` / `paths` / `logger` を注入
- **`buildContext(logger, { toolRoot?, userHome? })`** — テストで `toolRoot` と `userHome` を override して一時ディレクトリに閉じる。本番実行では override なしで `findToolRoot()`（`pnpm-workspace.yaml` を上方向に探索）と `homedir()` を使う
- サブコマンド追加時は `src/commands/` に実装を足し、`src/index.ts` に commander で登録
- **`paths.ts` / `config.ts` は `packages/core` に移動済**（CLI + MCP から共用）。`import { findToolRoot, loadConfigFromPaths, ... } from '@caveat/core'`

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
- `apps/cli` は bundle: true（default）でも動く。CLI が使う `node:` import は `os`/`path`/`fs`/`url` のみで、これらは Node が bare 名前も互換維持しているから。`node:sqlite` を import する core は別パッケージで、そちらは bundle: false なので問題なし

## Claude Code 統合の配置（Phase 10）

- **MCP サーバ**: `~/.claude.json`（`claude mcp add --scope user` で書き込み）。`~/.claude/settings.json` には書けない（schema validation で `mcpServers` フィールドが reject される）
- **Hooks**: `~/.claude/settings.json` の `hooks.UserPromptSubmit` と `hooks.Stop` に既存 throughline と並ぶ形で追加。`[caveat]` prefix 付き `<system-reminder>` を stdout に出す
- 実機確認: `claude mcp list` で `caveat: ... ✓ Connected` が出ればサーバ側 OK。hooks は spawn テストで fire を確認

## Hook 規約

- **必ず `exit 0`**。stdin の JSON パースエラーでも exit 0 + stderr にログだけ。
- **stdout**: `<system-reminder>[caveat] ...</system-reminder>` を**発火時のみ** 1 ブロック出す。非発火時は**完全無音**（token 節約）。それ以外の文字は書かない。
- **stderr**: 診断情報のみ。
- 既存の `throughline` hook（UserPromptSubmit / Stop）と並走する前提。

### Claude Code Hook の実装（Phase 6）

- [hooks/user-prompt-submit.mjs](hooks/user-prompt-submit.mjs) — プロンプトに GPU/driver/CUDA/nvidia/AMD/RTX/VSCode/Claude Code/flaky/再現しない/バージョン依存/native module 等のキーワードが含まれたら発火。キーワード一覧は `CAVEAT_TRIGGERS` 配列で管理
- [hooks/stop.mjs](hooks/stop.mjs) — 無条件で発火、ただし `payload.stop_hook_active === true` の場合は stdout 空（再帰防止）。メッセージは「解決した罠だけでなく `outcome: impossible` の結論も記録対象」を含む
- 両フックは standalone `.mjs`（import なし）。テストは spawn ベース（`hooks/tests/*.test.ts`）
- ロジック単体テスト用に `user-prompt-submit.mjs` は `detectCaveatTrigger` / `reminderText` を export。`stop.mjs` は `reminderText` を export
- `~/.claude/settings.json` に追記するパスは絶対パス（Windows 例: `C:\\Users\\<you>\\path\\to\\Caveat\\hooks\\user-prompt-submit.mjs`、Unix 例: `/home/<you>/path/to/Caveat/hooks/user-prompt-submit.mjs`）

### Git pre-commit visibility gate（Phase 7）

- [.husky/pre-commit](.husky/pre-commit) — Husky 9 が `core.hooksPath=.husky` を設定すれば git commit 時に自動発火。内容は `hooks/pre-commit-visibility-gate.mjs` を exec するだけの 1 行
- [hooks/pre-commit-visibility-gate.mjs](hooks/pre-commit-visibility-gate.mjs) — staged `entries/**/*.md` を `git diff --cached --diff-filter=ACMR` で列挙、`git show :<path>` で index 版（working tree でなく）を取得、`@caveat/core` の `parseMarkdown` で frontmatter 解析、`visibility: private` があれば blocked 一覧 + 修正案を stderr に出して exit 1
- **非 git ディレクトリや staged 対象なしは exit 0**。false-block を回避（`feedback_no_unnecessary_fallbacks` の範囲内、必要最小のガード）
- 緊急バイパスは `git commit --no-verify`（git 標準）。カスタム escape hatch は作らない
- `findBlockedFiles(stagedContents)` を export して unit テスト可能にしてある
