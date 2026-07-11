# 06 — 共有の製品化と索引の自己修復（v0.15 恒久対策）

> 状態: **承認済み・実装中**（2026-07-11 オーナー承認。本書が正本＝TODO を兼ねる）
> 前提: Fable 級統括／Codex 中位実装者（2026-07 時点）

## Context — なぜやるか

2026-07-11 の調査で確定した事実:

1. **索引乖離**: 正本 markdown 192 件に対し FTS 索引は 63 件。索引更新経路が「同一マシンの record/update 同プロセス upsert」と「手動 `caveat index`」しかなく、git pull で他端末から入った 131 件が hook・検索から不可視。改名由来の幽霊行も 2 件残存
2. **共有が製品機能に無い**: private データの共有（オーナーの全端末同期）は dotagents の symlink 配線に完全依存。Caveat 単独では own の同期手段が無い。public とラベルした 167 件も公開経路が無く、実質全部 private（ツール repo の entries/ 35 件は 2026-04 のスナップショットで停滞）
3. **visibility の意味が文書と実装と実運用でバラバラ**: 設計文書は「private = 1 台ローカル」のまま、実装の唯一の自動ガードは死に文（`*.private.md` gitignore に対し record は常に `<slug>.md` を生成）、実運用は private repo 経由で全端末同期済み

### 確定済みの設計判断（オーナー裁定 2026-07-11）

- **戦略 B**: Caveat は広める製品。公開 DB は知財流出ではなく製品の種（seed content）
- **visibility = 配布範囲の上限、二段階のみ**:
  - `private` = 保有境界内（**個人と組織を区別しない** — 「同じ private repo を push/pull できる人たち」が境界そのもの）
  - `public` = 第三者（世界）に出してよい
- **Caveat 単独で共有を完結させる**（dotagents 依存を製品機能に置き換える。ただしオーナーの現構成は壊さず並存）
- **repo 名は規約で決め打ち**: 非公開側 = `Caveat-Private`、公開側 = `Caveat-Public`。ユーザーは repo を自分で作らない — Caveat が `gh` CLI で自動作成（確認 1 回）。組織・自前ホスト用に `--repo <url>` 上書きは残す。固定名の副産物として `caveat community add <GitHubユーザー名>` だけで `<user>/Caveat-Public` を購読できる
- **見知らぬ他人の投稿の自動マージは永久にやらない**（v0.7 pivot 維持。罠エントリは hook でコンテキスト注入される＝prompt injection 面。世界からの受け入れは人間キュレーション必須）
- **ロードマップ**: Stage 1 = publish で種を撒く（今回実装）／ Stage 2 = 公開 repo への PR を人間レビューで受ける（運用、実装なし）／ Stage 3 = Cloudflare 上の Caveat Hub（投稿 API・検疫・連合検索。実需が出てから。方針のみ本書に記す）

### スコープ外（今回やらない）

- `source_project`（プロジェクト帰属記録）の復活 — オーナー未裁定。01_plan.md の旧設計記述（cwd 自動推定・Windows パス決め打ち）の**清算だけ**行い、論点として残す
- Stage 3 Hub の実装、MCP への sync/publish 露出、オーナー環境の dotagents → Caveat 管理への移行作業（任意・後日）
- `openDb` への busy_timeout 追加（チューニング定数の新設にあたるため見送り、未解決点として文書化）

---

## Track 1 — 自動再索引（索引の自己修復）

**設計**: 検知は前景・軽量、再索引は detached worker。既存の pending sweep（`maybeSweepPendingDirs` / `.last-sweep` マーカー / env kill switch / Stop hook 冒頭 try-catch）と同じ型。

- [ ] `packages/core/src/autoReindex.ts` 新規: `computeEntriesDigest`（own + 全 community の `(source, relpath, mtimeMs, size)` を sort → SHA-256。実測 193 files で 2–3ms）／マーカー I/O（`<caveatHome>/index/.entries-digest`、tmp 書き → `renameSync` の atomic 更新）／lockfile（`.reindex-lock`、`{flag:'wx'}` + pid 生存確認、**タイムアウト定数なし**。stale は ESRCH で破棄）／`reindexAllSources`（scanSource を own → 各 community に適用 + 消えた community source の行 purge。壊れ symlink 時は own 行を保持して warn）
- [ ] `packages/core/src/indexer.ts`: `walkMarkdown` を export（digest と scan が**同一 walk** を共有するのが検知一致性の要）
- [ ] `apps/cli/src/autoReindexTrigger.ts` 新規: 前景検知 + `spawn(node, [cli, 'hook', 'reindex'], {detached, stdio:'ignore'}).unref()`。順序: env `CAVEAT_INDEX_AUTOSYNC==='off'` → skip ／ DB 無し → silent skip ／ lock 存在 → skip ／ digest 一致 → skip（これが事実上のデバウンス。時間デバウンスは置かない — pull 直後の反映が目的）
- [ ] `apps/cli/src/commands/hookCmd.ts`: `stop` 冒頭の sweep 直後に trigger を try/catch 並置。`HookName` に `'reindex'` worker エントリ追加（digest snapshot → 全 scan 成功後にのみマーカー更新 → `.last-reindex.json` に結果記録。途中クラッシュ = マーカー未更新 = 次 Stop で自己修復）
- [ ] `apps/cli/src/commands/codexHookCmd.ts`: codex `stop` 冒頭に同じ trigger（worker は `hook reindex` を共用）
- [ ] `caveat index` / `pull` / `init` を `reindexAllSources` + マーカー更新に集約（init は同期実行 belt-and-suspenders — install 直後の索引空も解消）
- [ ] テスト: `packages/core/tests/autoReindex.test.ts`（digest 決定性・変化検知・lock・幽霊行掃除・source purge）／`apps/cli/tests/autoReindexHook.test.ts`（`hook reindex` E2E: FS 追加 → 再索引 → user-prompt-submit で浮上、stop 発火、clean skip、kill switch、lock 競合）

**発火点は Stop のみ**（PostToolUse は前景 ~20ms 予算、UserPromptSubmit はプロンプト遅延に直結。収束が 1 ターン遅れるだけなので不要）。

## Track 2 — Caveat 単独の共有（sync / publish / 境界執行）

**private tier**: `caveat sync` — own を Caveat 管理の git repo として private remote と同期。個人多端末も組織も同一機構。
**public tier**: `caveat publish` — frontmatter パース済み `visibility: public` のみを公開 repo へ一方向全置換ミラー。世界は `community add` で購読。

- [ ] `packages/core/src/remoteVisibility.ts` 新規: `deriveAnonymousProbeUrl`（https 素通し / scp・ssh 形式を https へ構文変換。ホスト名リスト禁止）＋ `probeAnonymousRead`（credential 無しで `<url>/info/refs?service=git-upload-pack` を GET。git smart-HTTP 共通仕様。3 値: `anonymous-readable` / `denied` / `indeterminate`。`PROBE_TIMEOUT_MS = 10_000` は命名定数+根拠コメント）
- [ ] `packages/core/src/sync.ts` 新規: preflight（非 repo / **own が外側 repo に内包 → `EXTERNAL_TOPLEVEL` 明示エラー（オーナーの dotagents symlink 構成はここで安全に拒否され、従来運用継続 + Track 1 が索引を拾う）** / detached HEAD / origin 無し）→ 境界検査 → `git add -A` + commit → pull --rebase（コンフリクトは `rebase --abort` で復元して明示エラー・ローカル commit は保持）→ own reindex + digest マーカー更新（Track 1 と接続、hook 側の冗長 worker を抑止）→ push
- [ ] **境界執行の規則**（sync 時）: remote が `anonymous-readable` かつ private/invalid エントリあり → **拒否・override 不可**。`indeterminate` かつ private あり → 拒否、`--trust-remote-private` 明示時のみ続行。`denied` → 続行。visibility 欠落/不正の .md は private 相当として算入しつつ invalid 列挙
- [ ] **セットアップの既定は決め打ち規約**: own が未設定のまま `caveat sync` を打ったら、(1) `gh api user` で GitHub ユーザー名を解決 → (2) `<user>/Caveat-Private` の存在確認 → 無ければ `gh repo create Caveat-Private --private` を**確認 1 回**の上で実行 → (3) remote 設定 + 初回 push。作成直後に匿名読取 probe で「本当に非公開か」を検証。`gh` が無い/未ログインなら黙らず「実行すべきコマンド 2 行」を提示して停止（silent fallback なし）。`--repo <url>` で組織 repo 等へ上書き可
- [ ] 既存 remote + ローカル空（2 台目導入）→ checkout + reindex ／ **両側に entries → 拒否**（自動マージしない、手動退避手順を提示）
- [ ] `packages/core/src/publish.ts` 新規: `collectPublishSet`（全 .md を parse、public のみ。**検査した bytes をそのまま持ち回り TOCTOU 排除**。invalid 1 件でも全体中止）→ ミラー workdir `<caveatHome>/publish/mirror`（clone or fetch + `reset --hard origin/<default>`）→ `entries/` 全消し → public のみ再配置（削除・改名の追従を機械的に保証）→ 決定的 README 生成（timestamp なし・購読方法つき）→ **出口検査 `verifyMirror`**（再パースで全件 public を assert + `findBlockedFiles` 併用の二重チェック）→ commit + push
- [ ] **publish の既定も決め打ち**: `publishTarget` 未設定で `caveat publish` を打ったら `<user>/Caveat-Public` を既定とし、無ければ `gh repo create Caveat-Public --public` を確認 1 回で実行 → `~/.caveatrc.json` に `publishTarget` を保存（`writeUserConfigPatch` 新設）。`caveat publish --init <url>` で上書き可（sync 側の remote は own/.git の origin そのものが状態なので config 不要）
- [ ] `caveat community add` が **裸の GitHub ユーザー名/組織名を受理**し `https://github.com/<name>/Caveat-Public` に展開（既存の URL 形式はそのまま維持）
- [ ] `packages/core/src/record.ts` L58: visibility フォールバック `?? 'public'` → `?? 'private'`（「迷ったら private」と整合）。読み取り側の `?? 'public'` 3 箇所（repository.ts / claudeHooks.ts / stale.ts）も `'private'` へ統一
- [ ] `paths.ts` に `publishMirrorDir`、`config.ts`/`types.ts` に `publishTarget: string | null` 追加。CLI コマンド登録（`apps/cli/src/commands/sync.ts` / `publish.ts`、`--dry-run` 両対応）
- [ ] テスト: remote は**ローカル bare repo**（`community.test.ts` の `initBareWithContent` 流用）、probe は `node:http` テストサーバ + スタブ注入。**publish の核心テスト = ミラーを別 dir に clone して private の bytes が 1 箇所も無いことを全走査 assert**。sync 往復（A で record → sync → B で sync → 到達）、コンフリクト復元、record デフォルト変更の回帰（`record.test.ts` L55 ほか `pnpm -r test` 全通し）

## Track 3 — 文書の正典化と清算

- [x] `docs/06_sharing_and_reindex.md` 新規（本書）
- [ ] `docs/01_plan.md` 清算: source_project の旧設計記述（cwd 自動推定・`c:/users/kite_/...` 決め打ち）を実装実態（null 固定）に合わせ、「private = コミット不可」の旧 visibility 記述を二段階定義へ差し替え
- [ ] `docs/private-tier-design.md` に「visibility 定義は 06 に更新済み」のヘッダ注記（歴史文書として保持）
- [ ] `CLAUDE.md` / `README.md`・`README.ja.md` / `CHANGELOG.md` 更新（sync/publish の使い方、`CAVEAT_INDEX_AUTOSYNC`、visibility 定義）
- [ ] ツール repo の `entries/`（35 件・停滞）: README に「正典の公開 DB は Caveat-Public」のポインタを追記（entries/ 自体は dogfood サンプルとして残置。移設は publish 開始後に判断）
- [ ] **dotagents 側（別 repo・小修正）**: README の「`*.private.md` は端末ローカル（gitignore で強制）」という事実と異なる記述を「private も含め dotagents（private repo）で同期。境界は caveat sync/publish が執行」に修正

## 実装の進め方 — オーケストレーション必須（統括コスト最小化）

**統括（Fable 5）は高額のため、自らコードを書かない。** orchestrate スキルの憲法 8 カ条に従う:

- **統括の責務（これのみ）**: 委譲契約の作成（file:line 証拠つき仕様 + 罠チェックリスト + 検証コマンドと合格条件）、委譲物の検証（diff レビュー + ゲート自分で再実行）、裁定、コミット（pathspec 明示）
- **実装物量 = 全部委譲**: `A: 役割=実装物量 →（Codex 中位, medium, codex_work・隔離 worktree）`。対象 = Track 1/2 の全実装・全テスト・Track 3 の docs 反映。並行時はディレクトリ非交差に割り、branch 切替・commit 禁止を契約に明記
- **F（契約クリティカル・統括が直接レビュー）**: 境界執行規則（enforcePrivateBoundary / verifyMirror / probe の enforce 表）のみ。実装は委譲してよいが、採用前に **refuter による敵対的検証**（「private が公開 repo に漏れる経路を見つけて殺せ」）を必ず通す
- **独立レビュー**: 各ユニットのコミット前に `codex_review` で差分レビュー（Claude レート非消費）
- 品質エスカレーションは統括裁量（安価枠で納得しなければ上位へ引き上げ、事実と理由を記録）
- 独立に revert 可能な単位で刻む: (1) Track 1 一式 → (2) record/読み取りの visibility デフォルト → (3) remoteVisibility + sync → (4) publish → (5) docs。各単位でフルゲート（`corepack pnpm -r test` + typecheck）→ コミット
- バージョン: 完了時 v0.15.0。npm publish・オーナー環境での `Caveat-Private`/`Caveat-Public` 実 repo 作成は**実行時に個別確認**（外向き操作）

## 検証（end-to-end）

1. `corepack pnpm -r test` / `corepack pnpm -r typecheck` 全通し（既存 259+ tests + 新規）
2. **索引自己修復の実地確認**: 本機で新版インストール → 任意セッションの Stop 後に `sqlite3 ~/.caveat/index/caveat.db "SELECT COUNT(*) FROM entries"` が **192**（=FS と一致）、幽霊 2 件消滅
3. **sync 実地**: 一時 CAVEAT_HOME + ローカル bare（または実 private GitHub repo）で record → sync → 別 home で sync → エントリ到達・索引済み
4. **publish 実地**: public/private 混在の own から publish → ミラー clone を全走査して private 不在を確認 → `caveat community add` で購読して hook 浮上まで確認
5. **オーナー現構成の無害確認**: dotagents symlink 構成で `caveat sync` が EXTERNAL_TOPLEVEL の説明つきエラーで止まり、既存 hook 動作・dotagents git 運用に影響なし

## 未解決点（本 track で解決しない・記録のみ）

- `openDb` の busy_timeout 既定 0: 再索引 worker と `caveat_record`/`markHit` の write が同 ms に重なると片方 SQLITE_BUSY（markHit は既存 try/catch で吸収、record は呼び手にエラーが見え再試行可）。busy_timeout 追加はチューニング定数新設のため見送り
- 壊れ frontmatter の .md が 1 枚あると reindex worker が毎 Stop 失敗し続ける（`.last-reindex.json` と stderr に明示、1 回数十 ms）。per-file 寛容化はフォールバック禁止と索引正確性に反するため現状維持
- push 後に GitHub 側で repo を private→public にフリップされた場合、既 push 分は防げない（次回 sync では検知・拒否）。Caveat の管轄外としてユーザー文書に明記
- `hooks/pre-commit-visibility-gate.mjs`（旧モデルの private commit 阻止）はツール repo の防波堤として現役維持。将来 publish 検査へ一本化して廃止する判断が残る
- `source_project` の扱い（private のみ帰属記録する折衷案が候補）— オーナー裁定待ち
