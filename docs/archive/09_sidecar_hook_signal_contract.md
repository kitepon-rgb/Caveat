# Sidecar hook signal contract

## 目的

Claude Code の `PostToolUseFailure` / error-bearing `PostToolUse` と `Stop` から
Codex sidecar advisory へ、助言の精度向上に必要な観測シグナルだけを渡す。
Caveat 検索に使うローカルの生テキストと、sidecar 境界を越える追加シグナルを分離し、
追加シグナル block へ秘密・個人情報・作業内容を混入させない。

## 契約

- Caveat 検索は従来どおり hook payload / transcript から抽出したローカル文字列を使う。
- sidecar へ渡す追加文脈は既存の `SidecarContextBlock kind: "manual_note"` を使う。
- 追加文脈の `source` は `caveat-hook-signal`、`trust` は `local` とする。
- `summary` と `data` は allowlist 済みの構造情報から決定的に生成する。
- 追加context fileは 4,096 bytes以下、通常file・非symlink・owner-only mode、block数は1とする。
- block / `data` はexact keyのみ、toolは閉じたenum（未知値は固定値 `other`）、
  countは0以上10,000以下の整数、`summary` は `data` から再生成したcanonical値との完全一致を要求する。
- tool-error で渡してよいのは、既知カテゴリへ正規化した tool 種別と失敗イベント種別だけ。
- Stop で渡してよいのは、tool failure 数、再編集された file 数（path なし）、
  WebSearch / WebFetch 数、Bash 再試行数、経過分だけ。
- tool input / output、エラー本文、検索語、file path、transcript、session id、任意文字列は渡さない。
- 追加文脈ファイルは private な一時ディレクトリへ置き、sidecar 呼び出し終了後に削除する。
- 同期advisory境界で追加文脈の生成・読込・検証・削除に失敗した場合、
  無信号で続行せず advisory を明示的失敗にする。detached worker内部の失敗は既存どおり
  次hookへ同期返却できないため、private job file・cleanup・次回以降の全hookでのstale回収を行う。
- sidecar の公開schemaは変更しない。既存の `manual_note` 契約で不足する実証が出た時だけ、
  codex-sidecar 側の新しい context kind を別変更として検討する。

## 非目標

- 生エラーや検索語を正規表現でマスクして sidecar へ送ること。
- Caveat retrieval の検索精度そのものを変更すること。
- sidecar advisory を hook の成否判定や自動修正の権限主体にすること。
- codex-sidecar の既存未コミット変更へ介入すること。

## 既存 context との境界

この契約のprivacy保証は新しい `caveat-hook-signal` blockだけを対象とする。
hook queryで取得した既存の `caveat_entry` は、従来からprivate entryを含み得て、
title / Symptom / environment / reference path等をsidecar providerへ渡す別の既存契約である。
本変更はその内容を新たに安全化したとは主張しない。

## 実施 TODO

- [x] 変更前の実raw logでcontextが`caveat_entry`だけだったことをcharacterization evidenceとして固定する。
- [x] allowlist 型と決定的な `manual_note` block builder を `@caveat/core` に追加する。
- [x] tool名を閉じたカテゴリへ正規化し、未知値や任意文字列を出力しないテストを追加する。
- [x] Stop の数値シグナルから path・error snippet・search query を除外するテストを追加する。
- [x] Caveat CLI に strict / bounded な追加context file入力を加え、retrieval contextと分離して結合する。
- [x] advisory runner が private temporary fileを生成・引き渡し・削除し、失敗を明示するようにする。
- [x] detached tool-error workerの生job fileをreserved root・versioned schema・0700 dir・0600 file・失敗時cleanup・24h stale回収で硬化する。
- [x] Claude tool-error worker と Stop reminder から構造シグナルを渡す。
- [x] fake sidecar Stop試験と両surfaceの実hook smokeで、許可フィールドの到達と禁止sentinelの非到達を確認する。
- [x] Caveat の unit / typecheck / build を通す。
- [x] 実 codex-sidecar + Luna で tool-error / Stop smokeを各1回通し、effective model policyとcontext到達を確認する。
- [x] Lunaで追加signal有無の小規模blind比較を行い、品質差と追加costを記録する。
- [x] codex-sidecar は既存 `manual_note` 契約で足りるか再確認し、変更不要なら理由を記録する。
- [x] `docs/03_dual_agent_support.md` と release checklistへ運用・privacy gateを反映する。
- [x] 全結果と残余リスクを本書へ記録する。

## ベースライン（2026-07-13）

- Caveat: 直前フェーズで workspace test / typecheck / build は green。
- codex-sidecar: `pnpm test` は script 内の `corepack` 不在で実行前失敗。
- codex-sidecar: 同じ package manager/version (`pnpm 10.10.0`) で script の各コマンドを
  直接実行し、core 257、CLI 10、MCP 19 tests、typecheck、build は green。
- codex-sidecar worktreeには別作業の未コミット差分があるため、本契約で不要な変更は加えない。

## 結果（2026-07-13）

- workspace gate: core 390、CLI 72、MCP 12、Web 17、hooks 9 tests、全typecheck、全buildがgreen。
- actual hook smoke: Stopと`PostToolUseFailure -> detached worker`の両方が成功。
  outbound `turn/start`のexact signal block、raw sentinel/session ID非到達、`thread/start`の
  `gpt-5.6-luna` / `low` effective policy、同一thread/turnのcompletedを結合確認した。
- paired synthetic A/B: Luna low、control/signal各4（各surface 2）。masked judgeのassistant
  primary modelは`claude-sonnet-5`で、Claude CLI terminal usageには補助
  `claude-haiku-4-5-20251001`も記録された。両条件4/4完遂、valid solutionは0/4から4/4、
  known-badは1/4から0/4。
- cost: control 0.129121、signal 0.134215 credits/run、差+0.005094（約3.9%）。
- artifact: `~/.caveat/local-eval/sidecar-advisory/hook-signal-ab/evaluation.json`、
  digest `f800e340e938f5da21f6eac10428e9f6dab529a7d47b091e4144e758857c6c36`。
- codex-sidecar変更: なし。公開済み`manual_note`は`trust: local`の明示overrideと任意JSON
  `data`を受理し、promptへ構造JSONとして渡すため、新kind追加の互換性コストは不要だった。

## 残余リスク

- A/Bはsynthetic paired n=4/conditionで、候補選択feasibilityだけを示す。実incidentの誤提案率へ一般化しない。
- 既存`caveat_entry`（privateを含む）のprovider境界は本変更のprivacy保証外。
- worker crash後にCaveatが二度と起動しなければ、0600のraw job orphanは次回sweepまで残る。
- codex-sidecar正規scriptを妨げていた環境の`corepack`不在は、Corepack 0.35.0導入後に解消した。
  pin済み`pnpm 10.10.0`で正規のtest / typecheck / buildを再実行し、すべてgreenを確認した。
