# Caveat 提案精度・実行信頼性の改善計画

作成: 2026-07-13
状態: 実装・ローカル検証完了、release gate実行中
対象: Caveat本体と、構造化出力契約を所有するcodex-sidecar

## 1. 目的

実運用で観測した次の問題を、BugHub連携と重複しない製品実装として修正する。

- 実際の失敗と弱くしか関係しないCaveatがhookから提示される。
- 同一または同種のreminderがenqueueされ続け、drain時に大量の省略表示が出る。
- Luna advisoryがJSON本体の後ろへ余分な文字を出し、sidecarが`PROTOCOL_ERROR`になることがある。
- Windows 2025 / Node 24の実Git統合テストが、runner負荷でVitest既定timeoutを超える。
- 公開packageのClaude fresh-session smokeが、隔離`HOME`ではkeychain認証を再利用できない。

成功条件は「表示件数を減らす」だけではない。関連する既知罠は引き続き提示しつつ、
無関係候補・重複提示・構造化出力失敗・非決定的なrelease gateを減らす。

## 2. Dotagents / BugHubとの所有境界

`/Users/kite/Developer/dotagents/docs/plan_bughub-factory-integration.md`を先に確認し、
同計画が所有する以下は本計画へ含めない。

- Caveatの機械可読diagnostics（DB schema/migration、own/sync、Claude/Codex hook、MCP）。
- Caveatのlocal structured error store、`collection.enabled` / `reporting.enabled`。
- runtime errorのfingerprint、severity、count、first/last seen、resolution、ack/cursor、retention。
- dotagents product adapter、report生成、outbox、再送、BugHub ingestion。
- BugHubのresolve/reopen、dashboard、Discord、daily/weekly、`/ai`連携。
- host×product matrix、scheduler、定期scan、全端末canary。
- 利用者feedbackをBugHubへ運ぶUI・API・telemetry。

Caveatは製品挙動と製品所有のテストを直す。dotagentsは後からCaveatの公開診断・固定smokeを
呼ぶだけで、Caveat内部の検索判定やpending DBを独自解釈しない。

## 3. 設計原則

1. **構造で絞る**: stopword、製品名、既知エラー文字列の除外リストを追加しない。
2. **入力の出所を保つ**: tool input、tool failure output、Stop error snippet、search queryを
   連結して出所を失わせない。
3. **発生源で重複を止める**: drain時に隠すだけでなく、enqueue前にsemantic keyでcoalesceする。
4. **壊れたJSONを救済パースしない**: code fence除去、先頭object抽出、末尾切り捨てを禁止する。
5. **無言fallback禁止**: schema非対応・protocol error・cleanup failureは区別して記録・表示する。
6. **検索評価とモデル行動評価を混ぜない**: retrieval回帰とsidecar実runを別artifactにする。
7. **中央報告を作らない**: 本計画のartifactはrepo test fixtureまたは明示実行のlocal一時物だけ。

## 4. 実装レーン

### Lane A — 誤提案のcharacterization（挙動不変）

- [x] 現在のproduction hook corpusとsession artifactをread-onlyで調べる。今回提示された候補の
  raw hit queryは現行設計で保存されずexact replay不能と確認し、その制約を実績へ記録する。
- [x] private本文・prompt・絶対pathをrepoへ保存せず、同じ構造だけを持つsynthetic fixtureへ変換する。
- [x] 少なくとも次を固定する。
  - tool inputの一般的なshell語と、別由来のgeneric error語を足した現行の誤hitを、既知の現状として固定する。
  - failure outputに症状根拠、tool inputまたはqueryに主題anchorがある時は既存hitを維持する。
  - UserPromptSubmitは単一prompt内で現行3段gateを維持する。
  - Stopはsearch queryだけ、またはgeneric failureだけでは提示しない。
- [x] `eval:hook-search`の現baselineを再取得し、corpus digestとprivate golden digestを記録する。
- [x] Lane Aは現行挙動のgreen characterizationだけを持つ。誤hitを0件へ反転する期待値は
  Lane Bの挙動変更unitへ置き、意図的なred testを独立commitの完了条件にしない。

### Lane B — provenance-aware hook検索（挙動修正・F）

契約クリティカル理由: 自動提示の採否を決める公開hook契約で、precision/recallを直接変えるため。

- [x] `@caveat/core`へ出所付き入力型を追加する。
  - `topicText`: tool input、command、検索queryなど「何について」の根拠。
  - `failureText`: tool response、error field、error snippetなど「何が壊れた」の根拠。
  - `surface`: `user_prompt | tool_error | stop`。
- [x] UserPromptSubmitは同じpromptをtopic/failure両証拠として扱い、現行互換を保つ。
- [x] tool-errorは、症状特異語を`failureText`から、rare topical anchorを`topicText + failureText`
  から要求する。異なる出所のgeneric語を単純連結して2-of-Nを満たさせない。
- [x] Stopはsession全体の`searchQueries`を`errorSnippets`と交差発火させず、各error snippetが単独で
  現行3gateを満たす時だけ候補化する。search queryは構造化signal/advisory文脈だけに使い、
  transcript本文・session ID・raw pathは検索入力にもsidecarにも追加しない。
- [x] `findCaveatsForPrompt`はUserPromptSubmitと旧hookの互換入口として維持し、hook専用の
  出所付きevaluatorへ内部委譲する。MCPは別契約の既存`search()`を変更しない。
- [x] Claude/Codex両adapterで同一core evaluatorを使い、host別の判定driftを禁止する。
- [x] 各候補の採否理由は純関数のtest resultとして検証できる形にするが、新diagnostics CLI、
  永続error store、telemetryは追加しない。
- [x] provenance用fixture/result schemaと評価scriptを別に追加し、surface別precisionとpositive recallを出す。
  既存`eval:hook-search`はUserPrompt互換面のbaselineとして守備範囲を明記する。

### Lane C — pending reminderの発生源dedupe（挙動修正・A）

- [x] reminder本文ではなく、`agent + surface + sorted(source,id) + stop signal digest`から
  advisory実行前に確定できるsemantic request keyを作る。advisory statusは最終metadataへ分離する。
- [x] sidecar呼出し前にsession/key単位の短命なinflight予約を`wx`で取得し、勝者だけがadvisoryを
  実行する。敗者は重複実行せず終了し、予約は`finally`解除と明示TTLでcrash回収する。
- [x] pending payloadは固有tempへ全量write・close後、no-replaceで`.ready`へ原子的に公開する。
  新規protocolは`.ready`だけを公開し、drainは移行互換の旧`.txt`も読む。create後write前crash、
  torn file、retryをfixtureで固定する。
- [x] semantic identityと表示順を分離し、`mtime + stable tie-break`で現行の最新context優先を維持する。
  旧timestamp `.txt`との混在も同じ時系列へ正規化する。
- [x] Stop reminderは既存のsession signal digestと統合し、同じsignal/related setを再enqueueしない。
- [x] drainの省略数をraw file数ではなく「dedupe後のunique context数−表示数」に直す。
- [x] dedupe済み3件以下なら省略行を出さない。大量の重複だけで`78件省略`のような表示を作らない。
- [x] enqueue競合、unlink失敗、同一内容、同一hit集合で順序違い、Claude/Codex/global queue、
  stale sweepとの競合を実filesystem fixtureで固定する。
- [x] drain結果はcleanup failureをcallerへ返し、固定・非反射のlocal stderr診断を出す。
  永続error storeや中央reportは作らず、unlink失敗時の次回再表示を明示テストする。
- [x] 100並行の同一keyでpending 1件かつsidecar invocation 1回、勝者crash後のTTL再取得、
  異なるkeyは抑止しないことを固定する。
- [x] 異なる有用候補を無制限に黙って捨てるcapは導入しない。容量上限が必要と実測された場合は、
  lossを明示する別契約として切り出す。

### Lane D — codex-sidecarの構造化出力拘束（別repo・F）

契約クリティカル理由: `turn/start` wire payloadと`SidecarResult`の公開互換を変更するため。

- [x] codex-sidecarで`generate`以外の現行workflow別structured output schemaをJSON Schemaとして一意に生成する。
- [x] `generate`は任意JSON object/arrayという既存契約を維持し、固定SidecarResult schemaを適用しない。
  caller schemaを別途契約化しない限り自由形式`outputContract`を厳格化しない。
- [x] Codex App Server `turn/start.params.outputSchema`へそのschemaを渡す。
  Codex CLI 0.144.1の`app-server generate-json-schema --experimental`で同fieldの存在を確認済み。
- [x] advisory/explore用schemaは`summary`、`recommendedNextAction`に加え、parserが`status: ok`と
  判定する全fieldをrequired・strictにする。既存parserのpartial/degraded受理契約自体は他caller向けに維持する。
- [x] field別schema policy（hard required / ok required / parser-only soft）と旧partial fixtureの
  期待statusを表で固定し、schema rejectとparser partialを混同しない。
- [x] schemaを送った正確な`turn/start` bytesをraw App Server logへ残し、smokeでdigestと
  matched turnを検証する。
- [x] schema非対応のCodex App Serverは明示的なcompatibility / protocol failureにする。
  schema無し再実行、別model reroute、壊れたJSONの部分抽出はしない。
- [x] 実行binaryのversionまたはcapabilityをpreflightし、`outputSchema`を黙って無視し得る未知・旧serverを
  明示失敗にする。fake rejectだけで対応判定せず、対応実serverのsmokeも通す。
- [x] fake App Serverでschema到達、valid result、末尾garbage、schema reject、旧server rejectを固定する。
- [x] fake App Serverで`generate`の任意object/array契約が変わらないことも固定する。
- [x] Luna lowのStop / tool-errorを各4 independent run実行し、8/8 valid JSON、known-bad 0、
  exact model/effort、`SidecarResult.status: ok`、Caveat advisory成功、raw signal非漏洩を確認する。
  成功runだけの選別は禁止する。
- [x] 8 runでprotocol errorが残った場合だけ、費用・重複助言・latencyを測った別計画で
  bounded retryを検討する。本計画では自動retryを入れない。
- [ ] codex-sidecarを独立commit・full gate・releaseし、その後Caveatのpublished smokeで固定する。

### Lane E — Windows実Git fixtureの決定性（A）

- [x] `community.test.ts`の実Git fixture helperへprocess timeout、`GIT_TERMINAL_PROMPT=0`、
  `GCM_INTERACTIVE=Never`を明示し、hangをrunner任せにしない。
- [x] `community.test.ts`だけでなく`autoSyncHook.test.ts`の子CLI・direct git helperも対象にし、
  全child processへphase名付きtimeoutと非対話envを適用する。
- [x] setup/cleanup/test timeoutを実Git用の命名定数へ分離する。値はWindows 2025実測p95と
  明示的なprocess timeoutより長くし、Vitest既定5秒を偶然の契約にしない。
- [x] timeout時はどのgit phaseで止まったかをfixture名付きで失敗させる。
- [ ] Ubuntu 24.04、Windows 2022/2025、Node 22/24を2連続greenにする。
- [ ] p95、採用timeout、根拠run IDを本書の実績節へ保存する。単なる2連続greenをprocess boundの証明にしない。

### Lane F — 公開packageのClaude fresh-session smoke（A＋H）

- [x] release checklistの「temp HOMEでClaude認証も再利用する」という誤った前提を削除する。
- [x] package、settings、MCP config、CAVEAT_HOMEは一時領域へ隔離する一方、Claude processの
  `HOME/USER/LOGNAME`は既存keychain認証identityを維持する。
- [x] `/tmp`から`--setting-sources project`、明示`--settings`、明示`--mcp-config`、
  `--strict-mcp-config`で起動し、実ユーザーのproject/local設定を読ませない。
- [x] 実行前に`claude auth status`を検査し、未認証なら成功扱いせず明示skip理由を出す。
- [x] `--include-hook-events --output-format=stream-json`をparseし、UserPromptSubmit/Stopの
  `exit_code=0`、結果sentinel、Caveat error不在、Haiku使用、予算上限を検証する。
- [x] fake Claude CLIによるCI E2Eと、release時だけの実Haiku smokeを分離する。
- [x] fake Claude CLIのscript名・stream-json fixture・CI stepを固定し、6 matrixの通常gateへ含める。
- [x] auth token、keychain内容、`.claude.json`の秘密fieldをcopy・表示・repo保存しない。

## 5. 実装順序とgate

1. [x] 全workspace baselineをgreenにし、Windows CI直近runとsidecar protocol error実測を保存する。
2. [x] Lane Aのcharacterizationを先に追加する。
3. [x] Lane Bを1挙動変更として実装し、retrieval baselineとpositive fixtureの回帰を確認する。
4. [x] Lane CをLane Bとの一体runtime commitで実装し、hook E2Eを通す。
5. [ ] Lane Dをcodex-sidecar repoで独立実装・releaseする。
6. [x] Lane EをCaveatのtest-only commitとして実装する。
7. [x] Lane Fをfake CI→実Claude smokeの順で実装する。
8. [ ] Caveat full gate、npm pack、published-package smoke、全6 CI jobを通す。
9. [x] 独立反証でprecision退行、silent fallback、BugHub責務混入がないことを確認する。
10. [ ] `docs/05_next_session.md`のcurrent handoffと`docs/03_dual_agent_support.md`のstatusを実績へ同期する。
11. [ ] オーナーのrelease承認後だけversion/tag/npm publish/global installを行う。
12. [ ] 実績と残余リスクを記録し、本書を`docs/archive/`へ移す。

## 6. 配置

- Lane B / D: `F: 契約クリティカル → 親直轄`。
- Lane A / C / E / Fの仕様固定後の実装・fixture: `A: 実装物量 → implementer`。
- 実Claude認証、npm publish、global install、本番設定変更: `H: オーナー承認`。
- refuterはLane B/Dの設計、最終diff、BugHub境界の重複有無を反証する。

実装時は各unitの前に配置を再宣言し、Aの大径作業はrouting smokeと
`verify-codex-agent-routing`成功後だけ渡す。単一file・数十行の小径修正は効率カーブアウトを使える。

## 7. 完了条件

- [x] synthetic false-positive fixtureが0 hit、既存positive fixtureがhitを維持する。
- [x] private `eval:hook-search`でprimary precisionを悪化させず、positive recallの変化を併記する。
- [x] 同じsemantic reminderを100回並行enqueueしてもdrainされるunique contextは1件。
- [x] 同じsemantic requestを100回並行処理してもsidecar invocationは1回である。
- [x] raw重複だけを理由に省略行が出ない。
- [x] sidecar Luna low 8/8がschema-validかつ`status: ok`でCaveat advisory成功となり、失敗runを分母から除外していない。
- [x] Caveatはsidecar failure時に引き続きfail-closedし、誤ったadvisoryを表示しない。
- [ ] Windows 6 matrixが2連続greenで、実Git processには明示timeoutがある。
- [ ] Windowsのcommunity/autosync全child processにphase付きtimeoutがあり、p95根拠を保存している。
- [ ] fake Claude hook stream parserが6 matrixのCIでgreenである。
- [ ] published-packageのnew Codex/Claude session、hook install二回、diagnostics、uninstallがgreen。
- [x] BugHub/dotagentsのdiagnostics・error store・reporter・outbox・ack・通知を変更していない。
- [ ] worktree clean、remote同期、計画archiveまで完了する。

## 8. rollback

- provenance-aware検索の意味論rollbackはcore＋Claude/Codex両adapterを一体unitとする。
  adapter単位revertは判定に影響しないhost固有配線だけに限定する。
- pendingの新`.ready`形式と旧timestamp `.txt`を同時drain可能にし、混在時も時系列契約を維持する。
- outputSchema変更はcodex-sidecar単独releaseでrevertし、Caveatへ壊れたparser fallbackを足さない。
- Windows/Claude smokeは製品runtimeから独立したtest/script commitとして戻せるようにする。

## 9. 敵対的検証記録

2026-07-13に`audit-gauntlet`で、矛盾、実現性、網羅性/引継ぎ、実環境整合を読み取り専用監査した。

- 件数遷移: `Find 18 → Dedup 14 → existence/value 2票反証で13 → Critic新規1 → 生存14`。
- 採用: Lane Aのred/green分離、MCP契約訂正、provenance評価、pendingの原子的公開・時系列・cleanup可視化・
  sidecar前single-flight、両host一体rollback、`generate`除外、schema/partial/status整合、旧server preflight、
  Windows autosync範囲、fake Claude CI gate、handoff正典更新。
- 棄却: `community.test.ts`の明示sequential化。現行Vitestは同fileを逐次実行しfixtureも分離済みで、
  観測されたtimeoutへの改善価値がないため。
- BugHub/dotagents責務の直接重複は実ファイル照合で見つからなかった。新diagnostics、永続error store、
  reporter、outbox、ack、中央通知を作らない境界を維持する。

実装後の独立refuter監査では、初回に7件（expired claimのABA、sweepとの競合、Claude smokeの
認証HOME、sidecar timeoutとclaim TTL、payload read失敗、旧v1 job cleanup、`generate` scalar説明）を採用し、
修正後の追加監査で2件（`staleDays=0`時のlive claim保護、hookの5秒上限を超えるSQLite busy wait）を採用した。
全9件を修正した最終再反証では、生存指摘0、protocol compatibility・fail-closed・BugHub境界の新規blocker 0。

## 10. 実績

### 2026-07-13 実装前ベースライン

- Caveat: workspace typecheck、release smoke、全513 test green。
- codex-sidecar: typecheck、lint、全291 test green（core 262 / CLI 10 / MCP 19）。
- Caveat `main` / codex-sidecar `main` は各`origin/main`とahead/behind 0、stashなし。
- Caveat直近CI: run `29218513010` green。直前のWindows timeout実測は計画作成時のrelease台帳を参照。
- sidecar protocol error実測とCodex 0.144.1 `outputSchema`確認は
  `rag/codex-app-server-output-schema/`および0.16.1 release台帳を参照。

### 2026-07-13 hook検索baseline

- `eval:hook-search`: 410 cases / 205 subjects / corpus coverage 1.0。
- micro precision@5: `155/257 = 0.6031128405`。
- positive hit@5: `151/269 = 0.5613382900`。
- negative any-hit: `52/141 = 0.3687943262`。
- corpus digest: `4bcbd48e0a5296f2248c83fff47d44da44de34693b6767d4a7a0ba6b6977af48`。
- golden digest: `5d6d4568bfa736025dedbb1c555c5c0f4e629794011a351788ee05e6ee28cac9`。
- runnerはown-onlyのUserPrompt互換面で、tie-breakはmachine間非決定的。provenance surfaceの評価値ではない。

### Lane A characterization

- `packages/core/tests/claudeHooks.test.ts`に、Stopのquery由来generic topicとfailure由来generic symptomを
  連結すると無関係entryが現行hitするsynthetic fixtureを追加した。
- query-only / generic-failure-onlyは各0 hit、既存のfailure症状＋topic anchor positiveと
  UserPrompt 3-gate互換は既存fixtureでgreen。
- 今回表示された3候補のraw hit queryは、hit queryを永続化しない現行契約のためsession artifactに存在しない。
  表示結果からraw prompt/errorを逆算せず、完全再生不能を残余観測制約として扱う。
- 受け入れ: core全396 test green、core typecheck green、production source差分なし。

### Lane B provenance-aware検索

- `findCaveatsForHook` / `findCaveatsForHookSegments`を追加。UserPromptは旧契約、tool-errorはfailureだけを
  symptom evidenceとし、Stopはerror snippet単位で評価してquery/error間・error間の足し算を禁止した。
- Claude worker jobをv2の`topicText` / `failureText`へ分離。旧v1 jobは実行せずstale sweepだけ互換回収する。
- Codex workerも同じfield分離とcore evaluatorを使い、temp jobをcreate-only 0600へ強化した。
- `eval:hook-provenance`を追加。strict JSONL、0600/0700、raw text/ref非出力、surface別集計を固定した。
- 既存410-case UserPrompt評価は全指標・corpus/golden digestともbaselineから不変。
- 統合受け入れ: 全workspace typecheck green、全525 test green。

### Lane D codex-sidecar構造化出力

- `generate`以外の6 workflowへclosed JSON Schemaを生成し、`turn/start.params.outputSchema`へ渡す。
  全objectは`additionalProperties: false`、宣言propertyは全required。任意nested detailはschema外に保ち、
  旧caller向けparserの`partial`契約を維持した。
- initialize `userAgent`でCodex App Server 0.144.1以上をpreflightし、旧版・未知版は`turn/start`送信前に
  `PROTOCOL_ERROR`。schema無しretryや別model rerouteは追加していない。
- fake App Serverのwire log、旧server拒否、`generate`非回帰を固定。実App Server初回で
  `additionalProperties: false`要件を検出してschemaを修正し、以後のLuna low実runはStop 4/4、
  tool-error 4/4、計8/8 `status: ok`。exact model/effort、closed schema、Caveat advisory、raw sentinel非漏洩を
  各runで検証した。自動retryなし。
- codex-sidecar変更後full gate: typecheck / lint / 297 tests（core 268 / CLI 10 / MCP 19）/ diff-check green。
- 初回の実モデル前失敗はinvalid schemaで、8-run受け入れ分母の前に根因修正した。修正後の8 model turnは
  成功runだけを選別せず全件green。

### Lane C pending reminder single-flight

- semantic keyをadvisory本文生成前に確定し、session/keyごとのcreate-only claim勝者だけが
  reminder build（ClaudeではLuna advisoryを含む）とatomic `.ready` publishを行う。
- pending mutation、claim、publish、drain、stale sweepは共通SQLite `BEGIN IMMEDIATE`でprocess間排他し、
  process crash時はOSがlockを解放する。expired claimの直接unlinkとsweep再帰削除を同じ排他内へ閉じた。
- claim取得直後に`.ready`を再確認し、「winner publish→claim解放」と「contender claim取得」の
  TOCTOUでbuilderが複数回走る窓を閉じた。crash claimは明示TTL後に再取得する。
- 実OS child 100並行でpublish 1件、別の100並行でbuilder callback 1回を3連続確認。
  refs順序、異なるkey、legacy `.txt`混在mtime順、torn temp無視、unlink失敗の再表示も固定した。
- Claude/Codex formatterの省略数はraw件数でなくdedupe後件数から計算し、cleanup失敗は本文を
  反射しない固定stderr診断としてcallerへ出す。
- Lane BとLane Cは同じClaude/Codex adapterの検索・enqueue境界を同時に変更するため、build不能な
  中間commitを作らず、一体runtime unit `0e43652`として記録した。Lane E/Fとrelease metadataは別commitに分離した。

### Lane E Windows実Git fixture

- `community.test.ts`と`autoSyncHook.test.ts`の全direct git / child CLIへ20秒process timeout、
  `GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=Never`、fixture名とphase付き失敗を追加した。
- setup 45秒、cleanup 30秒、suite 60秒を命名定数化。ローカルtarget testはgreen。
- Windows 2025の保存済みp95根拠がないため、20秒はprocess boundとして採用しただけでp95由来とは
  主張しない。remote 6 matrix 2連続とrun ID/p95記録はrelease前の未完gateとして残す。

### Lane F Claude fresh-session smoke

- fake CLIはsuccess、未認証、auth非JSON、hook失敗、誤model、stream非JSON、hook欠落、
  Caveat error、session timeout、auth timeoutを固定し、6 matrixのCI jobへ追加した。
- 実Claude Code 2.1.207をHaiku・予算上限`$0.05`・1回で実行し、UserPromptSubmit/Stopの
  `hook_started` / `hook_response`、各exit 0 / success、terminal sentinel、実効Haiku modelを確認した。
- 認証HOMEは維持し、settings、MCP config、`CAVEAT_HOME`、cwdだけを一時隔離した。
  token、keychain、組織情報、生streamは保存していない。仕様と実測は`rag/claude-hook-stream/`へ還流した。

### ローカル統合gate

- Caveat: workspace build / typecheck / release pack smoke / diff-check green、全545 tests
  （core 419 / CLI 88 / MCP 12 / Web 17 / hooks 9）green。
- `eval:hook-search`は410 casesの全指標、corpus digest、golden digestが実装前baselineから不変。
- npm registry現行版はCaveat 0.16.1、sidecar 3 packageとも0.3.5。両repoは実装開始時点の
  `origin/main`に対してahead/behind 0、stashなし。release前にfetchして再確認する。
