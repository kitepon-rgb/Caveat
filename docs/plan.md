# Caveat — 外部仕様 gotcha ナレッジベース（OSS + GitHub 流通）

## Context

ユーザーは `C:\Users\kite_\Documents\Program\` 配下に 38 個のサブプロジェクトを抱え、実装ロジックより「他人の仕様」（GPU/ドライバ、IDE/VSC の癖、Claude Code の hook 可否、ツールのバージョン制約など）の解明に時間を取られている。同種の調査の繰り返しを避けるため、**外部仕様の罠（caveat）を横断的に蓄積し、Claude が MCP/フック経由で自動参照・自動記録する**ナレッジベースを構築する。

加えて、**GitHub 上で公開し他人のナレッジも取り込んで成長させる** — 個人ツールでなくコミュニティ資産として運用する。参考: tetumemo 氏の「Claude Code × NotebookLM」記事（記憶の永続化と生きた知識ベース）。

**プロジェクト名**: `Caveat`（ラテン語 "beware" = 警告・但し書き）。ローカルフォルダ・GitHub repo・CLI・MCP サーバ名をこれに統一。現行の作業ディレクトリ `C:\Users\kite_\Documents\Program\Caveat\` は Phase 0 の時点でユーザーがリネーム済（`2ndBrain` → `Caveat`）。

**非ゴール**: 汎用 PKM。NotebookLM の完全自動化（公式 API 不在、v1 では半自動）。

## 設計の基本方針

1. **markdown-in-git が真実の源**。SQLite は再ビルド可能な派生検索インデックス（gitignore）
2. **Tool repo と Knowledge repo を分離**（OSS 流通と community import の対称性のため）
3. **visibility フラグ + pre-commit フック**で public/private を 1 repo 内管理
4. **Claude Code 統合**: MCP サーバ + UserPromptSubmit/Stop フック、既存 throughline と並走
5. **NotebookLM は半自動**: brief 生成と ingest の 2 tool だけ、人間の貼り付けを介す
6. **knowledge repo は Obsidian vault として開ける**。日常の編集・ローカル検索・グラフ・バックリンクは Obsidian 側に任せ、Caveat は Claude 統合（MCP/hook）・community import・公開 Web share の 3 点に特化する

## Repo 構成

### Repo A: `Caveat`（tool、public OSS）
`C:\Users\kite_\Documents\Program\Caveat\`（現状は `Caveat\`、必要ならリネーム）— 本プラン実装対象

```
caveat/
├── package.json                  (pnpm workspace root、name: "caveat")
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .gitignore                    (.index/, *.private.md, data/ 等)
├── .husky/pre-commit             (visibility:private をブロック)
├── README.md
├── LICENSE                       (MIT)
├── config/
│   └── default.json              (knowledge repo パス、community sources、semverKeys 等)
├── .index/                       (SQLite 派生インデックス、gitignore)
│   └── caveat.db
├── hooks/                        (Claude Code 用フック)
│   ├── user-prompt-submit.mjs
│   └── stop.mjs
├── packages/
│   └── core/                     (DB + ドメインロジック、@caveat/core)
│       ├── src/
│       │   ├── schema.sql
│       │   ├── migrations/       (NNN_*.sql、v1 初期は空)
│       │   ├── db.ts             (better-sqlite3, FTS5, マイグレーション)
│       │   ├── indexer.ts        (markdown → SQLite 差分インデックス)
│       │   ├── frontmatter.ts    (gray-matter ラッパ)
│       │   ├── repository.ts     (検索 API)
│       │   ├── env.ts            (OS/GPU/Node 実行環境 fingerprint)
│       │   └── types.ts
│       └── package.json
└── apps/
    ├── mcp/                      (MCP サーバ, stdio、@caveat/mcp)
    │   └── src/server.ts
    ├── web/                      (Hono 軽量 UI、@caveat/web)
    │   └── src/server.ts
    └── cli/                      (caveat CLI、@caveat/cli)
        └── src/index.ts
```

### Repo B: `caveats-quo`（individual knowledge、public）
別 repo として別途作成。tool 側の `config/default.json` が参照先として指す。複数形（caveat**s**）で「自分の警句集」を表す。

```
caveats-quo/
├── README.md                     (Obsidian vault として開ける旨 + 推奨プラグイン)
├── .gitignore                    (*.private.md, .obsidian/)
├── .templates/
│   └── caveat.md                 (Obsidian Templates コアプラグインが読むテンプレ)
├── entries/
│   ├── gpu/
│   │   └── rtx-5090-cuda-compat.md
│   ├── claude-code/
│   │   └── hook-availability-matrix.md
│   ├── vscode/
│   │   └── terminal-width-detection.md
│   └── ...
└── community/                    (他人の repo を import した clone、shallow clone)
    ├── <handle>/
    └── ...
```

**Obsidian vault としての扱い**:
- `caveats-quo/` をそのまま Obsidian で "Open folder as vault" できる
- `.obsidian/`（個人レイアウト、テーマ、プラグイン設定）は gitignore。各ユーザーが自分の設定を持つ
- `.templates/caveat.md` は commit する。Obsidian の Settings > Core plugins > Templates でテンプレートフォルダを `.templates/` に指定すると、`Insert template` コマンドから frontmatter スケルトンを呼び出せる（自動挿入ではなく明示実行）
- Obsidian で **ファイル名をリネームしたら frontmatter の `id` も合わせる**こと（Caveat は `id` で行追跡するので indexer 上は壊れないが、人間可読性が崩れる）
- 推奨プラグイン（README で案内）: Obsidian Git（commit/push/pull）、Dataview（frontmatter 横断クエリ）

### community import
- `caveat community add <github-repo-url>` → `community/<handle>/` に shallow clone
- `caveat community pull` → 全 community を `git pull`
- インデックス時に `source: community/<handle>` タグが付く
- 検索時にフィルタで自分 / 全体 / community 別々に引ける

## caveat エントリの markdown フォーマット

```markdown
---
id: rtx-5090-cuda-12-compat
title: RTX 5090 で CUDA 12.4 以前が初期化失敗する
visibility: public              # public | private
confidence: reproduced          # confirmed | reproduced | tentative
outcome: resolved               # resolved | impossible
tags: [gpu, nvidia, rtx-50xx, cuda]
environment:
  gpu: RTX 5090
  driver: ">=555"
  cuda: "<12.5"
  os: windows-11
source_project: llm-infer-bench
source_session: "2026-04-18T12:34:56Z/a7b3c9d1e2f4"
created_at: 2026-04-18
updated_at: 2026-04-18
last_verified: 2026-04-18
---

## Symptom
`cudaGetDeviceCount` が 0 を返し、`nvidia-smi` は正常。`torch.cuda.is_available()` が False。

## Cause
Blackwell（compute capability 10.x）は CUDA 12.5 以降でしか認識されない。

## Resolution
CUDA Toolkit を 12.5 以上にアップデート。PyTorch は cu125 wheel を使用。

## Evidence
- https://developer.nvidia.com/cuda-12-5-0-download-archive
- 再現コマンド: `python -c "import torch; print(torch.cuda.is_available())"`
```

- **id** はスラッグ。markdown ファイル名と一致させる（`<id>.md`）
- **visibility: private** はコミット不可（pre-commit でブロック）
- **environment** の比較仕様:
  - **semver キーのホワイトリスト**を `config/default.json` に `"semverKeys": ["driver", "cuda", "node"]` として持つ。リスト内キーは `semver.coerce` で正規化して semver 比較
  - semver キーかつ演算子付き（`>=, <=, >, <, =`）は範囲比較、演算子なしは `=` 扱い（semver 完全一致）
  - **誤ヒット防止**: `semver.coerce` の結果が元文字列先頭の `\d+(\.\d+){0,2}` 抽出と一致しない場合は semver 比較を放棄して false 判定（`coerce("windows-11") → 11.0.0` 等の暴発回避）
  - semver キー以外は lowercase substring match（演算子は受理しない）
- **source_project**: MCP サーバが cwd から自動推定。比較前に両辺を `path.resolve` → `toLowerCase()` → `replace(/\\/g, '/')` で正規化した上で、`~/.caveatrc.json` の `projectRoots: string[]`（正規化済み prefix のリスト、未設定なら既定 `["c:/users/kite_/documents/program/"]`）に含まれる prefix 配下であれば、その直下の最初のセグメントを採用。該当外は git root の basename、git 外なら `null`。WSL パス（`/mnt/c/...`）は対象外
- **source_session**: MCP サーバが `caveat_record` 実行時に自動付与（`<ISO-8601 UTC>/<ランダム 12 hex>`、48 bit）。Claude 側からの上書き不可
- **created_at / updated_at**: ISO-8601 TEXT
- **last_verified**: `YYYY-MM-DD`。該当罠が「今も有効と最後に確認した日」。`updated_at`（レコード編集時刻）と区別する意図。`caveat_record` 実行時は `created_at` と同値で自動付与。以降は明示更新のみ（`caveat_update` の更新可キー、ツール側の自動管理なし）。v1 では検索側での staleness 警告や閾値判定は実装しない（閾値の根拠データが未取得）
- **confidence** の意味:
  - `confirmed`: 根本原因が特定済で、再現コマンド/根拠リンクで独立再現が可能
  - `reproduced`: 複数回再現を確認したが、因果関係は仮説段階（「この設定にすれば直る」は分かるが「なぜ直るか」は未確定）
  - `tentative`: 1 回の観測で解決に見えるが、再現性・因果のどちらも未検証（いわゆる「動いたが理由不明」を含む）
- **outcome** の意味（`confidence` とは直交。「結論の種類」と「結論の確からしさ」を別軸で保持）:
  - `resolved`: 目的を達成できた。直接的な解決策でも、代替手段（迂回路）による達成でも `resolved`。`## Resolution` に具体策を書く
  - `impossible`: 現状の制約では目的の達成自体が不可能と判定。`## Resolution` に「結論: 不可能」「試した道: ...」「制約: ...」を書く。不可能判定も**強い知識**（次回誰かが同じ 3 時間を消費するのを防ぐ）として記録対象
  - デフォルトは `resolved`。v1 では `caveat_search` 側でのフィルタリング（`filters.outcome`）は実装しない（`entries` テーブルの列化は要件が見えてから）
- frontmatter 解析: `gray-matter`。YAML engine は JSON_SCHEMA 固定（`{ engines: { yaml: (s) => (jsyaml.load(s, { schema: jsyaml.JSON_SCHEMA }) ?? {}) as object } }`。Phase 2 で動作検証済、`!!js/function` 等 unsafe タグは throw）

## SQLite 派生インデックス

**Source of truth は md 本体**。SQLite は全カラム派生で、更新は常に md を書き換え → entries を再生成する一方向フロー。`caveat_update` も例外なく md 経由。

```sql
PRAGMA user_version = 1;

CREATE TABLE entries (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL,                -- frontmatter の id
  source TEXT NOT NULL,            -- 'own' | 'community/<handle>'
  path TEXT NOT NULL,              -- repo root からの相対パス
  title TEXT NOT NULL,
  body TEXT NOT NULL,              -- frontmatter 除いた md
  frontmatter_json TEXT NOT NULL,  -- 構造化メタ
  tags TEXT,                       -- JSON array
  confidence TEXT,
  visibility TEXT,
  file_mtime TEXT NOT NULL,
  indexed_at TEXT NOT NULL,
  UNIQUE (source, id)              -- community との衝突回避
);

CREATE VIRTUAL TABLE entries_fts USING fts5(
  id UNINDEXED, title, body, tags,
  content='entries', content_rowid='rowid',
  tokenize='trigram'               -- CJK 対応（SQLite 3.34+）
);

-- external-content FTS の同期トリガ
CREATE TRIGGER entries_ai AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts(rowid, id, title, body, tags)
  VALUES (new.rowid, new.id, new.title, new.body, new.tags);
END;
CREATE TRIGGER entries_ad AFTER DELETE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, id, title, body, tags)
  VALUES('delete', old.rowid, old.id, old.title, old.body, old.tags);
END;
CREATE TRIGGER entries_au AFTER UPDATE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, id, title, body, tags)
  VALUES('delete', old.rowid, old.id, old.title, old.body, old.tags);
  INSERT INTO entries_fts(rowid, id, title, body, tags)
  VALUES (new.rowid, new.id, new.title, new.body, new.tags);
END;
```

**マイグレーション**:
- **新規 DB**（`user_version=0`）: `schema.sql` を丸ごと実行（冒頭の `PRAGMA user_version = 1` で v1 に確定）。`migrations/NNN_*.sql` は**適用しない**（新規 DB はすでに最新）
- **既存 DB**（`user_version >= 1`）: `migrations/NNN_*.sql` のうち `user_version < NNN` のものを順次適用し、各実行末で `user_version` を更新
- v1 時点では `migrations/` ディレクトリは空。schema.sql が single source of truth

**インデクサ upsert 規約**:
- 走査は **source 単位**（`own` と各 `community/<handle>` を別々）。source ごとに touched rowid 集合を保持
- 走査中に触れた md について `(source, id)` で既存行を検索 → 見つかれば `UPDATE entries SET path=?, body=?, title=?, frontmatter_json=?, tags=?, confidence=?, visibility=?, file_mtime=?, indexed_at=? WHERE source=? AND id=?`、無ければ `INSERT`
- 走査完了後、**source ごとに 1 回ずつ** 次を発行して未タッチ行を一括削除:
  ```sql
  CREATE TEMP TABLE touched(rowid INTEGER PRIMARY KEY);
  -- touched に走査で触れた rowid を INSERT
  DELETE FROM entries WHERE source = ? AND rowid NOT IN (SELECT rowid FROM touched);
  DROP TABLE touched;
  ```
  一時テーブル経由にすることで `SQLITE_MAX_VARIABLE_NUMBER`（既定 32766）を超える数の rowid に対応
- FTS はトリガ連動なので indexer は `entries_fts` を直接触らない

**即時同期**: `caveat_record` / `caveat_update` は md 書き込み完了後、**同一プロセス内で当該 md 1 本についてのみ `(source, id)` upsert を同期呼び出し**する（直後の `caveat_search` で新規/更新行を拾えるように）。走査フェーズは起動時と `caveat index` のみ。

**`caveat index --full` の手順**:
1. db.ts 初期化（= migrations 適用）を必ず通す
2. `DELETE FROM entries;` を実行
3. 全 md を upsert 規約で再走査（`DELETE` 直後なので実質 INSERT 経路）

通常の MCP サーバ起動時は差分 upsert のみ。どのサブコマンドでも db.ts 初期化（migrations 適用）を最初に必ず通す。

**SQLite バージョン（検証済）**: Node 24.14 の `node:sqlite` が SQLite 3.51.2 を同梱、trigram tokenizer 可用性を 2026-04-18 に確認済。起動時に `--disable-warning=ExperimentalWarning` で実験フラグ警告を抑止。

**trigram の制約**: FTS5 trigram tokenizer は **3 文字以上のクエリ**でのみ一致（SQLite ドキュメント規定）。日本語 2 文字語（例: `仕様`）は単独クエリではヒットしない。title/body 側の文字列は普通に含められる（インデックス時は自動で全 trigram が生成される）。CLI/Web UI のクエリ入力バリデーションは v1 では行わない（ユーザーが自然に 3 文字以上で検索する想定）。

## MCP ツール（サーバ名: `caveat`）

**ログ方針（Critical）**: MCP stdio サーバは stdout に JSON-RPC メッセージ以外を書けない。MCP プロセス内で動く core のロガーは **stderr 固定**（CLI プロセスは stdout、MCP プロセスは stderr に差し替え可能な注入型にする）。

1. `caveat_search(query, filters?: { tags?, confidence?, source?, env? })` — FTS + frontmatter 絞り込み。**戻り値形**: `Array<{ id, source, title, symptomExcerpt: string (200 字), confidence, environment: object }>`
2. `caveat_get(id)` — **戻り値形**: `{ id, source, path, frontmatter, sections: Record<string, string>, body: string }`（sections のキーは H2 見出しに `trim()` のみ適用した値、大小は原文維持。body は frontmatter 除去後の raw md）。戻り値の sections キーは `caveat_update` の sections 入力にそのまま渡せる（update 側が `trim().toLowerCase()` で正規化して一致判定する）
3. `caveat_record(entry)` — 新規 md ファイル作成。未指定環境は `env.ts` が補完。`source_project` は cwd 推定。`source_session` はサーバ側で自動付与。`visibility` デフォルト `public`
4. `caveat_update(id, patch)` — 既存 md を merge して書き戻す。`patch` の形式は `{ frontmatter?: Partial<Frontmatter>, sections?: Record<string, string> }`。
   - **frontmatter merge**: shallow merge（`environment` も shallow）。**配列フィールド**（`tags` 等）は完全置換
   - **sections merge**: キー名と md の H2 見出しを `trim().toLowerCase()` で比較して完全一致なら該当段落を置換、一致しなければ末尾に追加（記号・trailing `:` は除去しない）
   - 保存時 `updated_at` を ISO-8601 UTC で自動更新
   - **更新可キー**: `title, confidence, outcome, tags, environment, visibility, last_verified, 本文セクション`
   - **不変キー**: `id, source, created_at, source_session, source_project, brief_id`
5. `caveat_list_recent(limit?)` — `updated_at DESC` ソート、戻り値は `caveat_search` と同一形（`Array<{ id, source, title, symptomExcerpt, confidence, environment }>`）
6. `nlm_brief_for(topic)` — 既存関連 caveat を引いた上で、NotebookLM に投げる**リサーチ依頼文**を生成して返す（人間が NLM に貼る）。**戻り値**に `brief_id`（ランダム UUID）を含め、後続の `ingest_research` で紐付け可能にする。`nlm_brief_for` 側では brief_id を DB に保存しない（stateless 発行）。`ingest_research` が呼ばれた md の frontmatter のみに永続化される（未 ingest の brief は追跡対象外、v1 の非ゴール）
7. `ingest_research(input)` — 入力スキーマ `{ title: string, symptom: string, cause?: string, resolution?: string, evidence?: string[], brief_id?: string }`。不足セクションは空見出しで生成、`confidence: tentative` 固定で保存。`brief_id` は frontmatter に記録
   - **id スラッグ化**: title を lowercase + 非 ASCII 英数ハイフン以外を `-` に置換。結果が空または先頭が英数でない場合は `entry-<yyyymmdd>-<6 hex>` をフォールバック
   - **id 衝突時**: 既存 id と衝突したら `-2`, `-3`, ... の数値サフィックスを付加して一意化。`caveat_record` も同じ衝突処理を適用

## Claude Code 統合

### `~/.claude/settings.json` 追記
```jsonc
{
  "mcpServers": {
    "caveat": {
      "command": "node",
      "args": ["C:\\Users\\kite_\\Documents\\Program\\Caveat\\apps\\mcp\\dist\\server.js"]
    }
  },
  "hooks": {
    "UserPromptSubmit": [
      { /* 既存 throughline */ },
      { "type": "command",
        "command": "node C:\\Users\\kite_\\Documents\\Program\\Caveat\\hooks\\user-prompt-submit.mjs" }
    ],
    "Stop": [
      { /* 既存 throughline */ },
      { "type": "command",
        "command": "node C:\\Users\\kite_\\Documents\\Program\\Caveat\\hooks\\stop.mjs" }
    ]
  }
}
```

### hook の役割
- **user-prompt-submit.mjs**: プロンプトが GPU/ドライバ/ツールバージョン/IDE/再現性の低い挙動 に触れそうなら、手を動かす前に `mcp__caveat__caveat_search` を呼べ、と `<system-reminder>` を出力
- **stop.mjs**: このセッションで再利用価値のある外部仕様の罠を発見したら `mcp__caveat__caveat_record` しろ、と出力。**「解決した」ケースだけでなく「現状の制約では不可能と判定した」結論も `outcome: impossible` として記録対象**（次回同じ 3 時間を消費しないため）

**並走規約**（既存 throughline と共存）:
- 両 hook は **常に exit 0**
- **stdout** には `<system-reminder>…</system-reminder>` を 1 ブロックのみ出力
- `<system-reminder>` **タグの内側の先頭** に `[caveat]` prefix を必ず付与（例: `<system-reminder>[caveat] ...</system-reminder>`）。他フックとの重複・混同を人間可読で区別、Claude 側の重複排除は期待しない
- ログ・診断情報は **stderr**
- 登録順 = 実行順、相互に依存しない

### pre-commit フック（`.husky/pre-commit`）
- 対象: `git diff --cached --name-only -- 'entries/**/*.md'`（staged の entries 配下 md のみ）
- `visibility: private` を含むファイルが混ざっていれば **非ゼロ終了でコミット拒否**
- amend / rebase は pre-commit が走るため同等に発火。stash は対象外
- `.gitignore` に `*.private.md` を含める（ファイル名規約の第二軸、多層防御ではなく別レイヤー）

## CLI

```
caveat init                          # config 初期化 + index 作成
caveat index [--full]                # 差分 / 全再構築
caveat search <query> [--source own|community|all] [--tag ...]
caveat list [--recent 20]
caveat show <id>
caveat serve [--port 4242]           # Web UI
caveat mcp                           # MCP stdio サーバ（settings.json 登録用）
caveat stats                         # 件数・タグ集計
caveat community add <repo-url>      # URL は ^https://github\.com/[^/]+/[^/]+(\.git)?$ のみ受理（v1 は GitHub 限定、他ホスト対応は将来拡張）
caveat community pull
caveat community list
caveat nlm-brief <topic>              # ターミナルから brief 生成
```

**config**:
- `config/default.json` は相対パスのみ（例: `"knowledgeRepo": "../caveats-quo"`）。**相対パス基準は tool repo root**。tool repo に個人パスを含めない
- ユーザー固有のパスは `~/.caveatrc.json` で上書き可。絶対パスと先頭 `~`（ホーム展開）を許可。`caveat init` 実行時に存在しなければ空 `{}` を生成
- ロード時のマージ規則: `deepMerge(default, user)` — object は再帰マージ、配列はユーザー側が完全置換、プリミティブはユーザー優先

## Web UI（Hono + SSR）

**read-only 共有ポータル**。編集は Obsidian に任せる（設計方針 6 参照）。

- `/` リスト + FTS 検索 + source/tag フィルタ
- `/g/:id` 詳細（md → HTML レンダ + メタ、wikilinks `[[slug]]` は `/g/slug` への内部リンクに展開）
- `/community` — 取り込み済み community 一覧 + pull ボタン

ビルドレス（SSR HTML + インライン CSS、最小限）、ランタイム依存は hono, @hono/node-server, markdown-it の 3 つ（wikilinks は自作で外部パッケージなし）。書き込み系エンドポイント（`/new`, `/g/:id/edit`）は持たない（Obsidian または md 直接編集 → `caveat index` で同期）。`caveat serve [--port 4242]` で起動。

## 技術選定

| 領域 | 採用 | 理由 |
|---|---|---|
| Monorepo | `pnpm workspace` | 軽量、symlink 方式 |
| DB | `node:sqlite` (builtin, Node 22.5+) + FTS5 | ネイティブビルド不要、Node 24 で SQLite 3.51.2 同梱・trigram 可用。実験フラグ警告は起動時に抑止 |
| Semver 比較 | `semver` | npm 公式、`coerce` で正規化 |
| Frontmatter | `gray-matter` | 業界標準、YAML サポート |
| MCP | `@modelcontextprotocol/sdk` | 公式 TS SDK |
| Web | `hono` + `@hono/node-server` + `markdown-it` + 自作 wikilinks プラグイン | 軽量 SSR + md→HTML レンダラ + Obsidian 風 `[[slug]]` / `[[slug\|label]]` を `/g/slug` にリンク展開。wikilinks は markdown-it の inline ルール拡張として 40 行で自作（外部パッケージ不採用、Phase 5 で検証済） |
| CLI | `commander` | 安定、既知の振る舞い |
| Git 操作 | `simple-git` | community clone/pull |
| ビルド | `tsup` | 素直な bundle |
| 開発実行 | `tsx` | |
| テスト | `vitest` ^4 + `vite` ^7 | vitest 2 + vite 5 は `node:sqlite` import を誤 resolve するため 4/7 系が必要（Phase 2 で確認） |
| pre-commit | `husky` + カスタム node スクリプト | visibility ブロック |

## 実装フェーズ

0. **リネーム** — `Program\2ndBrain\` → `Program\Caveat\` にフォルダリネーム（実装開始前）✅ 完了
1. **workspace 雛形** — root `package.json`（name: "caveat"）, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`, README, LICENSE（MIT） ✅ 完了（2026-04-18）
2. **`packages/core`** — types, frontmatter, env, db (schema.sql), indexer (md 差分インデックス), repository (FTS + filter), vitest 完備 ✅ 完了（2026-04-18、33 tests passing）
3. **`apps/cli`** — init / index / search / list / show / stats を先行実装（MCP より先に CLI で動作確認できるように）✅ 完了（2026-04-18、4 smoke tests passing、実機 `init`/`index`/`search`/`show` の e2e 動作確認済、`search "rtx"` 英語 FTS と `search "初期化失敗"` 日本語 trigram がヒット、`index --full` が DELETE→再スキャン）
4. **`apps/mcp`** — stdio MCP サーバ。7 tools を露出 ✅ 完了（2026-04-18、10 tool-handler tests passing、`initialize` + `tools/list` で 7 ツールの JSON-Schema 提示を stdio JSON-RPC 経由で確認済。`packages/core` 側に `id.ts` / `writer.ts` / `record.ts` / `update.ts` / `brief.ts` / `paths.ts` / `config.ts` を追加し 27 tests 増、合計 60 tests passing）
5. **`apps/web`** — Hono SSR で list / search / detail / community（read-only 共有ポータル。編集は Obsidian 側）✅ 完了（2026-04-18、13 tests passing: 5 wikilinks + 8 routes。`caveat serve --port 4243` 実機起動で `/` 一覧・`/?q=rtx` 英語 FTS・`/?q=初期化失敗` 日本語 trigram・`/g/rtx-5090-cuda` 詳細・`/community` すべて確認済。wikilinks は外部パッケージではなく markdown-it の inline ルール拡張で 40 行の自作プラグイン `[[slug]]` → `/g/slug` / `[[slug|label]]` → `/g/slug` (label))
6. **`hooks/`** — 2 つの Claude Code hook。並走規約（Claude Code 統合節）に従う（exit 0、stdout は `[caveat]` prefix 付き `<system-reminder>` 1 ブロック、stderr にログ）✅ 完了（2026-04-18、15 tests passing: 10 unit trigger detection + 5 spawn user-prompt-submit + 5 spawn stop。実機 JSON 入力で `RTX 5090 で CUDA 12.4` は発火・「Add a button」は無音・`stop_hook_active: true` でループガード発動を確認済。`hooks/` は `@caveat/hooks` として workspace 追加）
7. **`.husky/pre-commit`** — visibility gate ✅ 完了（2026-04-18、9 gate tests passing: 4 `findBlockedFiles` unit + 5 integration on temp git repo）。`.husky/pre-commit` は 1 行の shell で `hooks/pre-commit-visibility-gate.mjs` に exec。gate は `git diff --cached --name-only --diff-filter=ACMR -- entries/**/*.md` で staged md を列挙、`git show :<path>` で index 版本文を取得し `@caveat/core` の `parseMarkdown` で frontmatter 解析、`visibility: private` を含むものがあれば stderr に blocked 一覧 + 修正案を出して exit 1。非 git ディレクトリでは exit 0（false-block 回避）。Husky 9 を root devDep に追加、`prepare: husky` で git 初期化時に自動設定
8. **community 取り込み** — simple-git による shallow clone/pull、config から sources 読み込み ✅ 完了（2026-04-18、15 community tests passing: 8 URL validation + 2 handle collision + 4 integration on local bare repo + 1 list。`caveat community add|pull|list` の 3 サブコマンド実装。URL は `^https://github\.com/<org>/<repo>(\.git)?$` で validate（gitlab/ssh/http は拒否）。handle は repo 名から抽出、衝突時 `-2, -3, ...`。e2e: 手動で `community/test-remote/entries/webhook-race.md` を置いて `caveat index` → `source: community/test-remote` で分離、`caveat search stripe --source community` で正しく絞り込み、`caveat community list` で件数表示を確認済。community 管理ロジックは `packages/core/src/community.ts` に集約し Web UI と共用可能にしてある）
9. **Knowledge repo 別途作成** — `caveats-quo` を新規 GitHub repo として init、初回サンプル数件、`.templates/caveat.md` 配置、`.gitignore` に `.obsidian/` と `*.private.md` ✅ 完了（2026-04-18、`C:\Users\kite_\Documents\Program\caveats-quo\` にスキャフォールド。README.md（Obsidian vault 使用方法 + 推奨プラグイン Templates / Obsidian Git / Dataview）、`.gitignore`（`*.private.md`, `.obsidian/`）、`.templates/caveat.md`（frontmatter スケルトン + `{{date:YYYY-MM-DD}}`）、サンプル 2 件 `entries/gpu/rtx-5090-cuda.md` と `entries/nodejs/node-sqlite-experimental-warning.md`。**Phase 9 中に発見した副次バグ**: `caveat search "node:sqlite"` が FTS5 の `:` 演算子で死ぬ問題を確認し、`repository.ts` に `sanitizeFtsQuery` を追加して全 consumer から防御。8 tests 追加（core 計 83）。`brief.ts` のローカルサニタイザは削除して core 側に集約）
   - **9a. public 化前のサニタイズ**（Phase 9 の一部、2026-04-18）: tool repo を public push するにあたって以下を実施:
     - `packages/core/src/env.ts` の `DEFAULT_PROJECT_ROOTS` を個人パス hard-code から `[]` に変更（ユーザー固有 workspace 根は `~/.caveatrc.json` 側へ）
     - `config/default.json` の `projectRoots` も同様に `[]`
     - `.gitignore` を `**/.vscode/` / `**/.idea/` / `**/.claude/` の深い階層対応に拡張（`packages/core/.vscode/` の個人絶対パス漏れを未然にブロック）
     - `env.test.ts` の fixture を `kite_` → `alice` に置換
     - CLAUDE.md の絶対パス例を `<you>` プレースホルダ化
     - `docs/plan.md` の `C:\Users\kite_\...` 例は「Windows 開発環境の具体例」として意図的に残存。機微情報なし
   - **9b. GitHub push**（2026-04-18）: tool repo は **public** で [kitepon-rgb/Caveat](https://github.com/kitepon-rgb/Caveat)、knowledge repo は **private** で [kitepon-rgb/caveats-quo](https://github.com/kitepon-rgb/caveats-quo)。knowledge 側は初期は保守的に private、公開して問題ないエントリが貯まったら public 化を検討
10. **`~/.claude/settings.json` 更新** — MCP 登録 + hooks 追記（ユーザー承認後に実施）
11. **README 拡充** — セットアップ、他人の caveat repo を繋ぐ手順、OSS 公開時の CONTRIBUTING

## 検証

- `pnpm install && pnpm -r build`
- `pnpm caveat init && pnpm caveat index` → `.index/caveat.db` 作成、サンプル 3 件が index 済、`~/.caveatrc.json` が空 `{}` で生成される
- `SELECT sqlite_version()` が 3.34 以上（trigram tokenizer 可用性。Node 24.14 では 3.51.2 で 2026-04-18 検証済）
- `pnpm caveat search "rtx"` → ヒットすること
- `pnpm caveat search "初期化失敗"` → 日本語 trigram で CJK ヒットすること
- `pnpm caveat index --full` → entries が一度 DELETE されて再挿入される
- `pnpm caveat serve` → http://localhost:4242/ で list/detail/community が動作（read-only）、md 本文中の `[[slug]]` が `/g/slug` リンクにレンダされる
- `pnpm vitest run` → core のテストが全通過（frontmatter 解析、差分インデックス、FTS クエリ、pre-commit ゲート、environment 比較、path 正規化、config マージ）
- `~/.claude/settings.json` 更新後に Claude Code 再起動 → `/mcp` で `caveat` が 7 tools を公開
- 別プロジェクトで Claude に GPU 起因の再現しない問題を投げ、`caveat_search` が自動発火。該当なしなら `nlm_brief_for` が brief を返し、戻り値に `brief_id` が含まれること
- セッション終了後 `stop.mjs` が働き、Claude が `caveat_record` して md が 1 件増える。自動付与された `source_session` が `<ISO-8601>/<12 hex>` 形式であること
- `caveat community add https://gitlab.com/x/y` が allowlist で拒否されること
- `caveat_update(id, { frontmatter: { id: 'other' } })` 等の不変キー変更が拒否されること
- md ファイルをリネームしてから `caveat index` → 同じ `(source, id)` 行の `path` が新値に UPDATE され、孤児行が残らないこと
- `git commit` で `visibility: private` を含む md を混ぜたら pre-commit で弾かれること
- hook の stdout が `[caveat]` で始まる `<system-reminder>` 1 ブロックのみ、stderr にログのみ
- 既存 throughline（SessionStart / Stop / UserPromptSubmit）が引き続き動作

## 重要ファイル

- `C:\Users\kite_\Documents\Program\Caveat\package.json`（新規）
- `...\pnpm-workspace.yaml`（新規）
- `...\packages\core\src\schema.sql`（新規、`PRAGMA user_version = 1` 含む）
- `...\packages\core\src\migrations\`（新規ディレクトリ、`NNN_*.sql` 形式。v1 初期は空）
- `...\packages\core\src\indexer.ts`（新規、md ↔ SQLite の差分同期、upsert + 未タッチ行一括削除）
- `...\packages\core\src\repository.ts`（新規、FTS + frontmatter 絞り込み）
- `...\apps\mcp\src\server.ts`（新規、7 tools 露出）
- `...\apps\web\src\server.ts`（新規、Hono ルート + SSR）
- `...\apps\cli\src\index.ts`（新規、commander）
- `...\hooks\user-prompt-submit.mjs` / `stop.mjs`（新規）
- `...\.husky\pre-commit`（新規）
- `C:\Users\kite_\.claude\settings.json`（既存、最終段で追記。ユーザー承認後）
- **別 repo として新規作成**: `caveats-quo`（個人 knowledge、public）

## v1 以降の拡張（本プランには含めない）

- 埋め込みベクトル検索（sentence-transformers / ONNX）で semantic 類似
- Knowledge repo 間の相互参照・重複検出・自動マージ PR
- NotebookLM の agent-browser 経由の完全自動化
- コミュニティ registry（公開 Caveat repos の中央リスト）
- **エピソード/パターン層分離**: 現状は 1 entry = 1 罠（エピソード）の flat 構造。同カテゴリの罠が複数溜まってきた段階で、`patterns/` ディレクトリに抽象化層を導入し、複数 episode を参照する設計へ移行する選択肢。移行トリガー（件数・カテゴリ粒度）は v1 運用で実データが出てから判断
- **統計シグナル検知（セッション履歴からの登録トリガー）**: 現行の `stop.mjs` は Claude 自身の「苦戦した」認識に依存しており、**無自覚に乗り越えたケース**が構造的に漏れる。セッション履歴を機械解析して客観シグナル（同一ファイルの高頻度編集、ツール連続失敗、訂正の繰り返し等）を検知し、登録候補を提示する **primary 検知チャネル**として追加する。自己判定のフォールバックではなく、別種の証拠源による別経路。v1 運用でどの程度の漏れが顕在化するかを見てから、シグナル定義とトリガー実装を詰める
