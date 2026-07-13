# 誤提案と Caveat 介入効果の評価計画

状態: 完了
開始日: 2026-07-13
対象: Caveat の検索精度とは独立した、モデル出力の誤提案評価基盤。現段階は自己申告 artifact の検証・集計まで

完了時追記: 上の「対象」と初期裁定は着手時点の境界である。その後 P4A / P4B で
execution-provenance harness と execution-aware compiler まで実装・検証済み。実利用全体への
一般化や常時 transcript 収集は引き続き非目標とする。

## 目的

Caveat が「関連 entry を検索できたか」だけでなく、固定した既知罠 scenario に対して、
モデルが既知の誤提案を出したか、有効な代替解を出したかを再現可能に測る。

評価対象はユーザーへ外部化された回答だけとし、モデル内部の reasoning や棄却候補は扱わない。

## 現状のベースライン

- 既存 Track G は private golden 205 subjects / 410 cases を使う検索評価である。
- 2026-07-13 再測定値:
  - subject-macro positive recall@5: 119.6667 / 205 = 58.37%
  - subject-macro precision among returned@5: 109.45 / 160 = 68.41%
  - negative any-hit rate: 52 / 141 = 36.88%
  - cross-language hit@5（探索値）: 3 / 21 = 14.29%
- 変更前 baseline の全 workspace test は 436 件 green。全 workspace typecheck も直列実行で green。
- `CAVEAT_HOOK_QUERY_LOG=on` の 0-hit log は現環境に存在しない。
- Codex hook はインストール済みだが `codex_hooks` feature が無効で、現在の会話は Caveat hook の介入下にない。
- Codex rollout には外部化済み `commentary` / `final_answer` が存在するが、現行 Caveat parser は提案評価に使っていない。

## 裁定

### 分離する4レーン

1. **offline retrieval characterization**
   - 現行 `hookSearchEval` / Track G を維持する。
   - query から関連 entry を返せるかだけを測る。
2. **offline self-attested proposal artifact aggregation（実装済み）**
   - 固定 scenario と固定 reminder を宣言した control / treatment artifact を masked review で検証・集計する。
   - model 実行由来であることは証明しないため、behavioral evidence や介入効果とは呼ばない。
3. **execution-provenance characterization（実装済み）**
   - execution harness が割付から request 生成までを所有し、実 request と provider receipt を保存・検証する。
   - execution-aware compiler は全planを分母へ入れ、completed outputだけをmasked judgmentへ渡す。
   - provider署名や外部timestampは持たないため、bounded offline characterizationとして扱う。
4. **online privacy-preserving observability**
   - 本計画では設計境界だけ定め、常時 transcript 収集は実装しない。
   - online effectiveness は、提示・回答・訂正・結果を結ぶ観測と同意設計ができるまで名乗らない。

### 最小評価単位

1 trial は次を固定する。

- scenario
- host (`claude` または `codex`)
- model と version
- tool / permission policy
- 独立 run id
- 実行前に割り付けた condition (`control` または `caveat`)

最小比較 block は同一 scenario / host / model / policy 内の control と treatment の独立 run 群とする。
同じ会話内の before / after は carry-over があるため効果測定に使わない。
同一 block の treatment は同じ reminder digest、judgment は同じ judge/version に固定し、
介入内容やjudge差を condition 差へ混入させない。

### 判定項目

masked review の judge は condition を含まない packet だけを受け取り、次の2項目を別々に判定する。

1. 事前登録した `known-bad atomic claim` を回答が提案したか
2. scenario の根拠に照らして有効な代替解を回答が提示したか

拒否・沈黙で誤提案だけを減らす挙動を成功扱いしない。検索精度と行動評価を単一スコアへ合成しない。

## Privacy と保存境界

- raw prompt / output / tool policy / private reminder を含む trial は、既定で
  `<caveatHome>/local-eval/proposal/` に置く。これは knowledge repo の外であり、
  `caveat sync` / `publish` の対象外とする。
- raw artifact の親 directory は `0700`、file は `0600` を evaluator が fail-closed で検証する。
- evaluator は権限を黙って変更しない。raw prompt / output / entry id / path を stdout と error に出さない。
- 公開 repo に置くのは schema、validator、synthetic tests、集計ロジック、digest のみ。
- 現在会話の転記、hook feature 有効化、実モデル trial は別の明示操作とする。

## Artifact 契約

Track G の schema は流用せず、scenario、execution policy、assignment、trial、review packet、judgment を分離する。

### `scenarios.jsonl`

- `scenarioId`: 一意
- `scenario`: モデルへ渡す固定 scenario 本文
- `evidence[]`: `reference` / `content` / `digest`。digest は content bytes から再計算する
- `knownBadClaims[]`: 事前登録した原子的な禁止提案
- `validSolutionRubric[]`: 有効解の判定基準
- `reminder`: treatment へ直接注入する固定本文
- `scenarioDigest` / `reminderDigest`: evaluator が実 bytes から再計算して一致検証する

### `assignments.jsonl`

- scenario / host / model / policy block ごとに1 record
- `seed` / `algorithm` / run と opaque judgment ID の対応を持つ
- evaluator は seed と run ID から condition を再計算し、trial と一致検証する
- run 数は4以上の偶数、control / caveat を同数とする
- `judgmentId` は condition を符号化しない opaque lowercase hex とする
- manifest と出力 digest は artifact の内部整合性だけを証明し、事前登録時刻や model 実行遵守を証明しない。
  外部固定した pre-run digest と execution receipt がない値は、self-attested artifact aggregation とだけ呼ぶ

### `policies.jsonl`

- model snapshot、host adapter、system/developer instructions、tool schema/allowlist、permission mode、
  sampling settings の実 bytes を固定 key 順で canonicalize する
- `policyDigest` は evaluator が実 bytes から再計算する
- assignment / trial の host・model・policy 参照は manifest と一致必須

### `trials.jsonl`

- `trialId`: 一意
- `scenarioId`: 同一比較 block の識別子
- `host`: `claude | codex`
- `model`: model/version を含む非空文字列
- `policyDigest`: tool / permission policy の SHA-256
- `runId`: 独立 run の識別子
- `condition`: `control | caveat`
- `assignment`: assignment manifest から再計算された `randomized`
- `scenarioDigest`: scenario manifest の再計算値と一致必須
- `reminderDigest`: control は `null`、treatment は scenario manifest の再計算値と一致必須
- `output`: raw回答。local-only artifact から外へ出さない

### `judgments.jsonl`

- `judgmentId`: assignment manifest の opaque ID と1対1。trialId / condition は含めない
- `packetDigest`: judge に渡した review packet の再計算 digest
- `knownBadClaimEmitted`: `yes | no | unclear`
- `validSolutionSupplied`: `yes | no | unclear`
- `judge`: judge/version の識別子
- `judgePrompt` / `judgePromptDigest`: 判定指示の実 bytes と再計算 digest
- `maskedReviewAttested`: `true` 必須

### `review-packets.jsonl`

- validated scenario / trial から生成し、`judgmentId`、scenario、evidence、known-bad claims、
  valid-solution rubric、output、packet digest だけを持つ
- trialId、runId、condition、seed、reminder、model、policy は含めない
- evaluator は packet を元 manifest から再構成してdigestと完全一致を検証する

judge artifact と review packet は unknown key を拒否し、condition / trialId を持てない。
これは judge へ渡す入力を監査可能にするが、judge が他ファイルを読まなかったことまで暗号学的に
証明しないため、`blind` ではなく `masked review attestation` と呼ぶ。
同一比較 block では judge/version を固定する。

## Execution provenance 契約（P4A）

6 artifact aggregator の前段に、モデル呼び出しを所有する二相 harness を追加する。

### Phase 1: `execution-plans.jsonl`

`prepare:proposal-execution` は validated scenario / policy / assignment から各 run の実行計画を生成する。
モデルは呼ばない。出力先が既に存在すれば拒否し、`0600` で `O_EXCL` 作成する。

各 plan record は次を持つ。

- trial / run / judgment の opaque ID、再計算済み condition
- host、adapter、adapter version、requested model
- scenario / policy / assignment digest
- condition ごとに再構成した canonical request bytes の digest
- adapter が provider へ渡す最終 request bytes 本体、byte length、digest、channel / envelope 種別
- executable の absolute realpath / binary SHA-256 / version、実 argv、mode `0700` の空 cwd realpath
- deny-all から構築した最小 environment の非秘密値、credential-slot ID、provider endpoint / org / project routing
- 上記 invocation 全体を canonicalize した digest
- record 自体の `planDigest`

runner は全 plan file bytes の SHA-256 だけを stdout へ出す。外部時刻固定を自動では行わないため、
この digest 単独は事前登録時刻や因果性を証明しない。

### Phase 2: `execution-receipts.jsonl` と local-only output

`run:proposal-execution` だけが plan から provider CLI を起動する。任意 shell command adapter は認めず、
版管理した `codex-cli` / `claude-cli` adapter のみを許可する。

各 plan には成否にかかわらず terminal receipt を必ず1件残す。status は
`completed | unavailable | protocol_error | tool_attempted | nonzero_exit` とし、成功runだけを選別しない。
各 receipt は次を持つ。

- `planDigest`、canonical request / invocation digest
- 開始・完了時刻、CLI exit code、CLI version
- provider が出力内で報告した thread / session / response ID
- requested model、provider 出力から抽出した reported model snapshot、`modelProvenance`
  (`provider_reported | requested_only`)
- `requestSubmission` (`not_attempted | passed_to_spawn_sync | indeterminate`) と、`spawnSync` が
  戻ったrunだけの submitted request digest / byte length、channel / envelope 種別
- raw stdout / stderr digest、外部化回答の output digest、receipt digest

指定 model は reported model の代用にしない。Codex公式JSONLは実効modelを報告しないため、
Codex receiptは `reportedModel: null` / `modelProvenance: requested_only` とする。これは回答取得の
`completed` と両立するが、実効modelがprovider報告済みであるという主張には使えない。Claudeは
terminal resultの `modelUsage` が単一でassistant messageのmodelと一致するときだけ
`provider_reported` とする。複数modelはreroute混入の可能性があるため `protocol_error` とする。
Claudeのrequested modelはaliasでなくexact model ID必須とし、init / assistant / modelUsageの3者が
requested modelと完全一致しなければ `protocol_error` とする。
未知event schema、provider tool実行、非zero exit、ID不一致、digest不一致は
該当statusのterminal receiptへ記録し、そのrunを全plan分母へ `unclear` として残す。
比較 block から成功runだけを選ぶこと、assignmentを事後に作り直すことは禁止する。
既存のreceipt / trial 出力はfail-closedとする。raw stdout / stderr / request / output は local-only file に保存し、
console へは path や本文を出さない。

`validateProposalExecutionProvenance` は現P4Aでは plan / receipt を scenario / policy / assignment へ再結合し、
request bytes、conditionごとの reminder 有無、invocation、provider ID、reported model provenanceを検証する。
completed answer本体は各run cwdの `output.bin` に保存し、receiptの `outputDigest` と再開時に照合する。

P4A runnerは全planのterminal receiptと `execution-outcomes.jsonl` までを生成する。P4Bの
execution-aware compiler / evaluatorは、全receiptを入力としてnoncompleted runを `unclear` に変換し、
completed runだけをmasked reviewへ渡す形で実装済みである。全planにterminal receiptが無ければ
比較block全体を不成立とする。ただし実scenario suite、実モデルtrial、masked judgmentはまだ無いため、
現時点は「synthetic execution chainがgreen」であって「効果測定済み」ではない。

## Execution-aware compiler 契約（P4B）

P4Bは全planに1件の `execution-outcomes.jsonl` をatomic生成する。outcomeはplan / receiptのdigest、
trial / run / judgment ID、scenario / host / requested model / policy / condition、terminal status、
model provenance、output / output digest（completedだけ）、record digestを持つ。

実行前に `execution-suite.json` を`O_EXCL`で固定する。suiteは全assignment block key、assignment digest、
全plan digest、plan count、suite digestを持つ。runner / compiler / evaluatorは同じsuiteを必須入力にし、
runだけでなくscenario / host / model / policy block丸ごとの欠落・余剰も拒否する。suite自体の外部timestampや
第三者署名は非目標なので、これは所有者による再封印を防ぐ事前登録証明ではなく、同一評価バッチ内の
事後切り落としを検出するlocal manifestである。

- `completed`: local-only `output.bin` のbytesとreceipt `outputDigest` の一致を必須とする
- noncompleted: outputは必ずnull。既知回答や安全判定を捏造しない
- outcomeの欠落・重複・余剰、plan / receipt / assignmentとの不一致は比較全体を拒否する
- 同一comparison blockではadapter / adapter version / executable digest / credential slot / routing / cwdと
  request以外の実質argv・environmentをcanonical `runtimeDigest`として固定し、receipt CLI versionも一致必須とする
- compilerはraw stdout / stderr bytesのdigestを照合し、固定adapter parserを再実行する。導出したstatus、
  provider ID、reported model provenance、output bytesがreceipt / output.binと一致しなければ比較全体を拒否する
- completed outcomeだけmasked review packetとjudge judgmentを要求する
- noncompleted outcomeにはpacket / judgmentを作らず、evaluator自身がknown-bad / valid-solutionの
  両方を `unclear` として全plan分母へ入れる
- 全planがnoncompletedでも、0-byteのpacket / judgment artifactを正規の空集合として受理し、
  0件のmasked reviewで全planを `unclear` として集計する
- planned cwdは専用 `local-eval/proposal/execution-work/` 配下かつknowledge repo外に限定し、
  初回実行前に空であることを要求する
- console出力にはscenario ID、scenario本文、回答本文、local-only pathを含めない
- 手作り `trials.jsonl` やcompletedだけの部分集合をexecution-aware metricsへ混ぜない

execution-aware evaluatorはhost / requested model / policy / scenarioごとに既存と同じ上下界を出す。
model provenanceは集計キーにせず、stratum注記を `requested_only | completed_provider_reported |
provider_reported` とする。これによりClaudeのcompletedとnoncompletedを別stratumへ分断しない。
Claudeはcompleted全件でexact reported model一致を要求する。Codexは`requested_only`であることを出力へ明記し、
実効modelが検証済みとは呼ばない。review packetはcondition / status / model / reminder / trial IDを含まず、
既存masked reviewと同じ漏洩境界を守る。

### Adapter policy

- 共通: mode `0700` の空 working directory、非interactive、session persistence無効、raw output local-only、
  executableはprepare時にabsolute realpath解決してbinary digestを固定
- Codex: `exec --json --ephemeral --ignore-user-config --sandbox read-only` を基礎とし、tool系eventが出たrunは
  `tool_attempted` terminal outcome として分母へ残す。公式実装と同じく、turn完了前に出た最後の
  completed `agent_message` を最終回答とする
- Claude: subscription authを保ったままcustomizationを止める `-p --output-format stream-json --safe-mode --tools "" --no-session-persistence` を基礎とする
- environmentはdeny-allから必要最小を構築し、API base / proxy / 3P provider routingを暗黙継承しない。
  秘密値は保存せずcredential-slot IDで同一性だけを固定する
- samplingをCLIが固定できない場合は policy の temperature / topP / seed を `null` 必須とし、固定済みと偽装しない

P4Aのestimandは **offline CLI adapter上の prompt-injected reminder characterization** である。
Claude `<system-reminder>` / Codex `additionalContext` という実hook配送階層を再現しないため、本番Caveat hookの
介入効果とは呼ばない。provider署名付きreceipt、CLI binaryの改ざん耐性、外部timestamp、実利用全体への
一般化はP4Aの非目標である。

長いrunの途中crashに備え、run開始marker、spawn結果marker、raw、output、terminal receiptはrun単位で
temp file → fsync → atomic rename する。再開時はterminal receipt済みrunを再実行しない。開始markerだけなら
submissionを `indeterminate` として `unavailable` で閉じ、spawn結果＋rawがあれば再parseして
output-before-receipt crashから同じterminal receiptを再構成する。再構成不能なoutputはquarantineする。

## 指標

host / model / policy ごとに分離して、分子・分母と共に出す。

- known-bad claim rate bounds（全 randomized trial を分母にし、`unclear` を下限/上限へ反映）
- valid solution rate bounds（同上）
- safe-and-useful rate bounds（不明を成功に数えない下限と、成功可能性を残す上限）
- scenario ごとの treatment - control difference bounds
- stratum の scenario-macro difference bounds（trial-micro を主指標にしない）
- scenario / condition / judgeable / unclear 件数

Claude / Codex の pooled effect、異なる model/version の pooled effectは出さない。

## 非目標

- 実利用全体への改善率推定
- live task で warning を意図的に抜く A/B test
- 単発 before / after からの因果主張
- Caveat entry 本文との一致を現実の正解とみなすこと
- raw transcript の常時保存
- reasoning / chain-of-thought の収集や評価
- retrieval と behavioral effect の単一スコア化
- 本計画内での検索ゲート、ranking、embedding の変更

## 実行 TODO

- [x] **P0 — 現状監査とベースライン**
  - [x] 既存知識、Track G、現行 hook / transcript / pending 経路を確認
  - [x] 全 workspace test と typecheck を green で確認
  - [x] private hook search golden を再測定
  - [x] 現行案を独立反証し、検索評価の延長案を棄却
- [x] **P1 — 公開可能な行動評価コア**
  - [x] `packages/core/src/proposalEval.ts` に trial / judgment parser、validator、集計を実装
  - [x] raw値を error に含めない mismatch error を実装
  - [x] host / model / policy 別集計と分子・分母を実装
  - [x] synthetic vitest で schema、masked review、未判定、重複、条件不足、集計を固定
- [x] **P2 — local-only evaluator runner**
  - [x] `scripts/eval-proposal-quality.mjs` を追加
  - [x] 既定 artifact path と `0700` / `0600` fail-closed を実装
  - [x] stdout を schema/version、digest、集計だけに制限
  - [x] root package script `eval:proposal-quality` を追加
- [x] **P3 — 統合と正典化**
  - [x] 全 workspace test / typecheck / build を実行
  - [x] synthetic artifact で runner の成功・privacy error を確認
  - [x] `CLAUDE.md` と関連 docs に retrieval / behavioral / online の分離を反映
  - [x] 独立 refuter に existence / value / privacy / metric semantics を再監査させる
  - [x] 実行 provenance 不在の high 指摘を採用し、現段階の呼称を artifact aggregator へ限定
- [x] **P4 — オーナーゲート後の実測**
  - [x] H: 全文会話は転記せず、許可判断に必要な2発言だけのbounded excerptを専用`CAVEAT_HOME`へlocal-only保存
  - [x] H: `gpt-5.6-sol` / `claude-sonnet-5`を各4 run実行し、利用量を記録
  - [x] H: Codex hook featureは既に`codex_hooks = true`と確認し、設定変更なしで維持
  - [x] execution harness が assignment manifest digest を実行前に固定
  - [x] harness が canonical request digest、condition-specific envelope digest、provider response/run ID、model provenance、開始時刻を receipt に記録
  - [x] control の reminder 不在と treatment の固定 reminder bytes を request から検証
  - [x] H: bounded excerptを事前登録scenario suiteにし、conditionを実行前ランダム割付
  - [x] H: StructuredOutput拘束のmasked Sonnet 5 judgment後、初回characterizationを`~/.caveat-p4-latest/local-eval/proposal/characterization-summary.json`へ記録
  - [x] 結果は両hostともcontrol/caveat各2/2でsafe-and-useful、known-bad 0、差0。control天井効果のため害も増分効果も未観測、一般化不可
- [x] **P4A — execution-provenance harness**
  - [x] 公式CLI仕様とローカル `--help` を調査し、`rag/proposal-execution-provenance/` へ保存
  - [x] plan / receipt / adapter / fail-closed 契約を正本化
  - [x] 独立 refuter に provenance / privacy / provider schema / value を反証させる
  - [x] post-treatment selection、write-boundary不在、binary/env未固定の指摘を採用
  - [x] core の plan / receipt parser、digest再計算、join validator を実装
  - [x] `prepare:proposal-execution` を実装し、モデル未呼出し synthetic E2E を固定
  - [x] Codex / Claude adapter と fixture parser tests を実装
  - [x] `run:proposal-execution` を実装するが、実モデルはH承認後だけ起動
  - [x] fake Codex CLI E2Eで completed / tool_attempted / start-only・cwd欠落 unavailable、
    submitted bytes一致、output-before-receipt復旧、秘密非露出、再実行拒否を確認
  - [x] 全receiptを分母にするexecution-aware outcome / judgment compilerを実装
  - [x] 全 workspace test / typecheck / build と synthetic execution E2E を通す
  - [x] 独立最終反証で既知compiler blocker以外の新規 blocker / high なしを確認
- [x] **P4B — execution-aware compiler / evaluator**
  - [x] 全plan outcome、completed-only masked judgment、noncompleted自動unclearの契約を正本化
  - [x] execution前suite manifestでblock-level selectionを拒否
  - [x] comparison block内runtime固定でcondition依存CLI混入を拒否
  - [x] raw stream再parseでjudged outputをprovider出力へ結合
  - [x] outcome parser / digest / 全artifact join validatorを実装
  - [x] completed-only review packet生成とcondition非漏洩を実装
  - [x] noncompletedを全plan分母へ入れるbounds / scenario-macro metricsを実装
  - [x] runnerからatomic outcome生成へ接続
  - [x] local-only evaluator scriptとsynthetic E2Eを実装
  - [x] all-noncompleted、dedicated cwd、scenario ID非露出のprivacy回帰を固定
  - [x] 独立反証と全workspace gateを通す
- [x] **P4C — Codex sidecar advisory model policy再評価**
  - [x] OpenAI公式の最新model用途区分・subscription limit・token creditを `rag/codex-sidecar-model-policy/` へ保存
  - [x] 現行policyが `gpt-5.4-mini` × lowで、モデル選択はCaveat側 `.codex-sidecar.yml` の責務と確認
  - [x] 独立反証のhigh 6件（surface混同、単発裁定、usage契約不在、private/run汚染、terminal policy不在、実signal/actionable context不送信）を採用
  - [x] 現行hookはStop/tool-error本文をproviderへ送らず、固定promptとCaveat title/Symptom等だけを送るため、現行契約のmodel比較はincident advisory精度を直接測らないと確認
  - [x] `sidecar-advisory-study/v1` runnerを実装し、正常、usage欠落、process argv不一致、不均衡割付をsyntheticでfail-closed検証
  - [x] `stop | tool_error` を別stratumにし、各surfaceで複数のsynthetic/public scenarioとcontext有無を事前登録
  - [x] feasibilityは各scenario/model 1 run、採用判定はminiと生存候補を各stratum合計4 independent runsへ増やす。model順はseed固定ランダム化
  - [x] opaque packetをSonnet 5の同一judge/versionへ渡し、model/surface/runを隠してknown-badとvalid-actionを別判定
  - [x] codex-sidecar 0.3.5 raw event用versioned usage receiptを作り、input/cached/output/reasoning token、raw digest、model-turn/total latencyを結合。provider-reported modelは現schemaに無いためrequested+process argvまでとし、欠落・未知schemaは0でなくunavailable
  - [x] runごとのclean isolated project rootを使い、raw logをrepo外local-evalへ0600保存。private Caveatは不使用
  - [x] Lunaが両stratum計8/8完遂・known-bad 0・valid-action 8/8でmini以上となり、`gpt-5.6-luna` × lowを明示入力契約の採用候補に決定
  - [x] Solは自動採用対象外として未実行。Terraはfeasibility 4/4までで打ち切り、追加creditsを使わない
  - [x] synthetic/public context付き比較は将来の明示入力契約のfeasibilityに限定する。private signal送信、現行hookへの入力追加、production preset変更は別H/privacy gateなしに行わない
  - [x] 実測はLuna 0.1225 credits/run・平均7.5秒・p95 9.1秒、mini 0.1467 credits/run・4/8完遂・平均10.1秒、Terra 0.2818 credits/run（feasibility 4件）
  - [x] 初回context 6件のsidecar schema不備はprovider未到達として全セルを明示除外し、均衡した修正batchで置換。Sonnet 5の補助Haiku usage・thinking_tokens通知をraw実測に基づきparserへ追加
  - [x] protocol/format理由で不採用にしたSonnet 5 raw 3本と採用judgmentを再照合し、全IDの判定値が完全一致してretry選択バイアスなしを確認
  - [x] model policy変更を `.codex-sidecar.yml`、smoke期待値、release checklist、dual-agent正典へ同一刻みで反映
  - [x] 採用後にStop / tool-errorのactual hook smokeを隔離fixtureで別々に通し、両方のraw logでLuna lowを確認。全workspace gateと最終反証を通す
- [x] **P1R — 最終反証で成立した必須修正**
  - [x] scenario / evidence / known-bad claim / valid rubric / reminder manifest と digest 再計算
  - [x] assignment manifest、opaque judgment ID、unknown key reject、balanced allocation
  - [x] 全trial分母の outcome bounds と scenario-macro difference
  - [x] resolved knowledgeRepo 配下の artifact 拒否と stdout model digest 化
  - [x] 6 artifact の `0700` / `0600` fail-closed runner と回帰test
- [x] **P1R2 — review provenance と execution policy**
  - [x] content-addressed execution-policy manifest と assignment / trial join
  - [x] condition非含有 review packet の生成・digest・完全一致検証
  - [x] judgment を packet / judge prompt digest と masked-review attestation へ結合
  - [x] 6 artifact runner、stdout非露出、回帰test

## 配置

- F: 評価契約、因果主張、privacy境界、採用裁定 → 親 Codex
- A: 仕様固定済み validator / metrics / runner / tests → implementer（ネイティブ委譲）
- H: raw会話転記、実モデル利用、ユーザー設定変更 → オーナー

## 検証コマンド

```sh
node scripts/pnpm.mjs -r test
node scripts/pnpm.mjs -r typecheck
node scripts/pnpm.mjs -r build
node scripts/pnpm.mjs eval:hook-search
node scripts/pnpm.mjs prepare:proposal-review
node scripts/pnpm.mjs prepare:proposal-execution
node scripts/pnpm.mjs test:proposal-execution
node scripts/pnpm.mjs prepare:proposal-execution-review
node scripts/test-proposal-execution-judge.mjs
node scripts/pnpm.mjs eval:proposal-execution
node scripts/pnpm.mjs eval:proposal-quality
```

`eval:proposal-quality` は local-only artifact が未作成なら明示失敗を正とする。
