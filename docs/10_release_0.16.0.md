# caveat-cli 0.16.0 release plan

## 目的

`v0.15.0`以後の封緘公開層、community復号索引、autosync、init統合、公開検閲・検索計測、
repository-local proposal evaluation基盤、Luna sidecar advisory、bounded hook signal、worker tempfile
hardeningを`caveat-cli@0.16.0`としてGitHubとnpmへ公開し、公開tarballからのfresh installと
Claude/Codex hook動作を確認する。

## 非目標

- `/Users/kite/Developer/codex-sidecar`の既存dirty変更をcommit・push・releaseしない。
- 既存private `caveat_entry`のprovider境界をこのreleaseで変更しない。
- synthetic A/Bを実incident全体の精度保証として表現しない。
- repository-local proposal harnessをnpm tarball同梱のCLI機能として表現しない。
- npm公開後に同じversionを上書き・履歴改変しない。

## リスクとrollback

- npm versionはimmutable。publish後の欠陥は`npm deprecate`または修正版`0.16.1`で対応する。
- push前はcommitを追加修正できる。push後はforceせずforward fixする。
- global install smokeは一時prefix/HOMEを使い、実ユーザー設定を変更しない。
- repository全体のdirty差分を1 releaseへ含めるため、pathspecを明示してstage内容を監査する。

## TODO

- [x] `docs/08_proposal_effectiveness_eval.md`を完了文書として`docs/archive/`へ移す。
- [x] 完了済み`docs/07_sealed_public_and_autosync.md`を現状へ更新し`docs/archive/`へ移す。
- [x] 全変更のscope、秘密、生成物、不要ファイル混入を監査する。
- [x] versionを`0.16.0`へ揃え、lockfileとCHANGELOGを更新する。
- [x] workspace build / typecheck / tests / standalone eval tests / diff-checkを通す。
- [x] `check:release-smoke`、`check:npm-pack`、`pnpm publish --dry-run`を通す。
- [x] packed tarballのmanifest、bin mode、workspace protocol不在、内容一覧を確認する。
- [x] 独立refuter監査で公開blockerがないことを確認する。
- [x] release対象だけをpathspec付きでstageし、stage diffを再監査する。
- [ ] 日本語commitを作成し、`main`をpushする。
- [ ] GitHub Actionsのpush CIがgreenになるまで確認する。
- [ ] annotated tag `v0.16.0`を作成・pushする。
- [ ] `caveat-cli@0.16.0`をnpm publishする。
- [ ] npm registryのversion / dist-tag / integrityを確認する。
- [ ] 公開packageを一時prefixへfresh installし、version / manifest / executable modeを確認する。
- [ ] 一時HOMEでinit二回、Claude/Codex hook diagnostics、uninstall cleanupを確認する。
- [ ] 公開packageでnew Codex / Claude session smokeとsidecar advisory両surfaceを確認する。
- [ ] worktree clean、origin同期、npm latest、CI greenを確認する。
- [ ] 結果と残余リスクを記録し、本書を`docs/archive/`へ移す。

## 着手時点

- branch: `main`、`origin/main`との差0、stashなし。
- npm auth: `quolu`、`caveat-cli` latest=`0.15.0`。
- Corepack=`0.35.0`。Caveatはpnpm `10.0.0`、codex-sidecarは`10.10.0`。
- Caveat workspace gateとactual Luna hook smokeは直前フェーズでgreen。
- codex-sidecarのdirty変更は別作業であり、本release対象外。

## 公開前検証結果（2026-07-13）

- workspace build / typecheckはgreen。core 390、CLI 72、MCP 12、Web 17、hooks 9の計500 tests green。
- keyserver独立packageはpnpm workspace入口を修復し、frozen install、18 tests、typecheckがgreen。
- standalone proposal / sidecar synthetic E2E 5本、release smoke、npm pack install、publish dry-runがgreen。
- 実Luna low sidecar smokeはStop / tool-error両surfaceでgreen。canonical hook-signal blockがexactly one、禁止sentinel非到達、matched turn completionを確認。
- refuter最終裁定はblocker / high / mediumゼロ、release可。
