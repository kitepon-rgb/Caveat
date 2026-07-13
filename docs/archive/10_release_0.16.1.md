# caveat-cli 0.16.1 release plan

## 目的

`caveat-cli@0.16.0`のfresh new-session smokeで発見したCodex feature key互換性不良を修正し、
同じ機能一式を`caveat-cli@0.16.1`として公開する。現行Codexの正規`[features].hooks`をinstallerと
diagnosticsが一貫して扱い、公開tarballからのClaude/Codex hook動作を確認する。

## 非目標

- `/Users/kite/Developer/codex-sidecar`の既存dirty変更をcommit・push・releaseしない。
- 既存private `caveat_entry`のprovider境界をこのreleaseで変更しない。
- synthetic A/Bを実incident全体の精度保証として表現しない。
- repository-local proposal harnessをnpm tarball同梱のCLI機能として表現しない。
- npm公開後に同じversionを上書き・履歴改変しない。

## リスクとrollback

- npm versionはimmutable。`0.16.0`はdeprecated済みで、修正版`0.16.1`をforward fixとして公開する。
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
- [x] 日本語commitを作成し、`main`をpushする。
- [x] GitHub Actionsのpush CIがgreenになるまで確認する。
- [x] annotated tag `v0.16.0`を作成・pushする。
- [x] `caveat-cli@0.16.0`をnpm publishし、fresh new-sessionでdeprecated feature keyを検出する。
- [x] `caveat-cli@0.16.0`をnpm deprecateする。
- [x] installer / diagnosticsを正規`features.hooks`へ移行し、install時に旧aliasを安全に除去する。
- [x] version / CHANGELOGを`0.16.1`へ更新し、全gate・refuter監査を通す。
- [x] 修正版commitをpushし、全6 CI job greenを確認する。
- [x] annotated tag `v0.16.1`を作成・pushし、`caveat-cli@0.16.1`をnpm publishする。
- [x] npm registryのversion / dist-tag / integrityを確認する。
- [x] 公開packageを一時prefixへfresh installし、version / manifest / executable modeを確認する。
- [x] 一時HOMEでinit二回、Claude/Codex hook diagnostics、uninstall cleanupを確認する。
- [x] 公開packageでnew Codex sessionとsidecar advisory両surfaceを確認し、Claude fresh sessionの未実施理由を記録する。
- [x] worktree clean、origin同期、npm latest、CI greenを確認する。
- [x] 結果と残余リスクを記録し、本書を`docs/archive/`へ移す。

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

## 0.16.1 forward-fix検証（2026-07-13）

- OpenAI公式config referenceとCodex CLI 0.144.1実測で、正規keyが`features.hooks`、
  `features.codex_hooks`がdeprecated aliasであることを確認し、RAGへ保存した。
- 0.16.0が生成した隔離configを0.16.1開発版で再installし、`codex_hooks = true`から
  `hooks = true`へbackup付きで移行、旧aliasゼロ、diagnostics=`available`、evidence=`hooks stable true`を確認した。
- 移行後の新Codex sessionは応答成功し、deprecated / invalid hook / hook failureなし。
- Claude fresh new-sessionは隔離HOMEで認証を再利用できず`Not logged in`のため未実施。
  Claude hook install二回・uninstall cleanupとCLI unit 80件はgreen。
- Codex uninstallは共有featureを無効化・移行しない。0.16.0から直接uninstallした場合は旧aliasが
  残るため、警告解消には0.16.1で一度installしてからuninstallする。
- workspace build / typecheck、core 395、CLI 80、MCP 12、Web 17、hooks 9の計513 tests、
  release smoke、npm pack install、publish dry-runがgreen。refuter最終裁定はrelease可。

## 公開・導入結果（2026-07-13）

- commit `5279445`を`main`へpushし、GitHub Actions run `29218218948`のUbuntu / Windows、
  Node 22 / 24全6 jobがgreen。annotated tag `v0.16.1`は同commitを指す。
- `caveat-cli@0.16.1`をnpmへ公開。`latest=0.16.1`、shasumは
  `b75423437af2bc74126dae395971e6bd58b01e6a`、integrityは
  `sha512-SzgJUK3HZ2/93VN+W86uiR5Aq+TmKWS/LKv9ZCazkfwHebdkp6X0G4ohDc7QI2vBMMBLn+YouB7v4uk33gDX7A==`。
  `0.16.0`はdeprecatedのまま維持した。
- 公開packageを隔離prefixへfresh installし、version、manifest、bin実行権限を確認。
  0.16.0生成configの`codex_hooks = true`を0.16.1で`hooks = true`へ移行し、旧aliasゼロ、
  二回目install無変更、diagnostics=`available`、uninstall後のCaveat hookゼロを確認した。
- 隔離HOMEで`init`二回、Claude/Codex登録、Codex diagnostics、両uninstall cleanupを確認した。
  公開hookを使う新Codex sessionは`CAVEAT_0161_SESSION_OK`を返し、deprecated / invalid hook /
  hook failure警告なし。Claude fresh new-sessionだけは隔離HOMEで認証を再利用できず未実施。
- 公開CLIと`gpt-5.6-luna` / lowでsidecar advisoryのStop / tool-error両surfaceがgreen。
  ただしStop初回はモデル出力JSON末尾の余分な文字により`PROTOCOL_ERROR`となり、Caveatは
  advisoryを流さず`advisory unavailable`へfail-closedした。同条件の再試行は成功したため、
  単発の構造化出力信頼性はsidecar側の残余リスクとして別途改善対象にする。
- 実環境の`/opt/homebrew/bin/caveat`をnpm global installで`0.15.0`から`0.16.1`へ更新した。
