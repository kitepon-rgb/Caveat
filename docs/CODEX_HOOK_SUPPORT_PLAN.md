# Codex Hook 対応 試験・実装計画

> **Status (2026-05-08)**: 本計画はリリース済み。Codex primary hooks
> (`caveat codex-hook install|diagnostics|user-prompt-submit|post-tool-use|stop`)
> と sidecar advisory (`caveat codex-sidecar diagnostics|smoke|run|work-smoke`)
> が **v0.14.2** で投入され、`advisory` preset 化が **v0.14.7** で完了。
> Claude / Codex 両ホストの実運用検証済 (詳細は
> [docs/05_next_session.md](05_next_session.md)、`CHANGELOG.md`、
> [docs/03_dual_agent_support.md](03_dual_agent_support.md))。
>
> 本文中の `- [ ]` チェックボックスは**投入時の作業単位の記録**として
> 残してあるが、計画段階の整理項目で実体は実装で解消済み。
> 仕様の真実は `CLAUDE.md` の「Claude Code Hook の実装」節と
> `docs/03_dual_agent_support.md` を参照。新規修正をする時はチェックボックスを
> 増やさず、それぞれのコード箇所に直接 PR を投げる。

この文書は、Caveat に Codex hook 対応を追加するための TODO 兼
実装計画書です。`CLAUDE.md` と `docs/03_dual_agent_support.md` に対する
追加文書として扱います。

`CLAUDE.md` は、既存の Claude Code 統合に関する正本です。Codex 対応の
ために、Claude 向けの command、hook 名、stdout 文言、markdown field、
transcript 前提、install 挙動を書き換えてはいけません。

## 目標

Caveat が Claude で持っている 3 つの hook 発火点と同等の動作を、Codex
でも使えるようにします。

| Claude | Codex | Caveat の処理 |
|---|---|---|
| `UserPromptSubmit` | `userPromptSubmit` | prompt から既存 caveat を検索して、作業前に関連 reminder を浮上させる |
| `PostToolUse` | `postToolUse` | tool error を拾い、async worker / pending reminder 経路へ流す |
| `Stop` | `stop` | session evidence から苦戦シグナルを検出し、`caveat_update` または `caveat_record` を促す |

目的は Caveat の思想や機能範囲を広げることではありません。Claude で既に
成立している Caveat の振る舞いを、Codex session でも同じ意味で使える
ようにします。

## 現時点の根拠

- 現行の `codex features list` では `hooks` が `stable true`。旧
  `codex_hooks` はdeprecated alias（0.16.1で正規keyへ移行）。
- ローカル app-server schema 生成結果には、hook event として
  `userPromptSubmit`、`postToolUse`、`stop` が出ている。
- 同じ schema には追加で `preToolUse`、`permissionRequest`、
  `sessionStart` も存在する。
- 隔離 `CODEX_HOME` + 一時 hook config で `UserPromptSubmit`、
  `PostToolUse`、`Stop` の実 stdin payload を capture 済み。
- Codex hook config の event key は `hooks.json` 上では `UserPromptSubmit` /
  `PostToolUse` / `Stop` の PascalCase で動作確認済み。
- runtime payload の `hook_event_name` も capture では `UserPromptSubmit` /
  `PostToolUse` / `Stop` の PascalCase だった。一方、app-server schema の event enum
  は lower camel なので、実装では config key と docs schema 名を混同しない。
- `UserPromptSubmit` の stdout は
  `hookSpecificOutput.additionalContext` により次 turn の developer context として
  見えることを capture で確認済み。
- Codex は hook stdout 全体を 1 個の JSON object として parse する。pending
  reminder が複数ある場合や pending reminder と prompt hit が同時にある場合でも、
  stdout に JSONL / 複数 JSON object を出さず、`additionalContext` 文字列へ結合する。
- Codex の `UserPromptSubmit` drain では、古い backlog を一気に表示しない。
  repeated `Stop` reminder は最新 1 件に畳み、表示する context block 数には上限を置き、
  省略があれば短い summary line だけを追加する。
- Codex `Stop` は per-session signal digest を保存し、同じ transcript signal を
  毎 turn 再 enqueue しない。tool failure 数や related caveat などが変化した場合だけ
  新しい Stop reminder を積む。
- `PostToolUse` payload は `tool_response` を持つが、少なくとも capture した
  Bash 失敗 payload では exit code field が stdin に含まれない。Codex transcript
  の同じ `tool_use_id` / `call_id` に対応する `function_call_output` から
  `Process exited with code N` を読む必要がある。
- ただし実運用 smoke では、`PostToolUse` hook が完了するまで transcript の
  `function_call_output` が確定しない挙動を確認した。Codex hook から detached
  child を起動して後で transcript を読む方式も実 Codex では pending を残せなかったため、
  Codex `PostToolUse` 前景 hook は `tool_input` + `tool_response` を既存 Caveat
  symptom に当て、hit がある場合だけ pending を積む。
- `Stop` payload は `transcript_path` と `last_assistant_message` を持つ。苦戦
  evidence は Codex transcript JSONL から読む。
- ただし、OpenAI の公開 Codex docs には、Claude Code の hooks reference
  のような詳細仕様はまだ見つかっていない。
- そのため、これは「binary patch や log scraping の Hack」ではないが、
  「公開仕様として十分に文書化済み」とも言い切らない。
- `~/.codex/sessions/*.jsonl` は実装詳細として扱う。`stop` 実装で読む必要が
  ある場合は、その依存を明示し、diagnostics で検査できるようにする。

## 非目標

- Claude hook を Codex hook に置き換えない。
- 既存の `caveat hook <name>` の Claude 向け挙動を変えない。
- Codex に「いつ Caveat が喋るべきか」を決めさせない。
- Codex hook 非対応環境を silent fallback で隠さない。
- 基本的な hook 動作を codex-sidecar に依存させない。Codex hook 対応は、
  primary Codex session に対して成立させる。sidecar advisory は別経路の
  optional な second opinion として扱う。
- Codex primary session で Caveat を使うためだけに、Codex から codex-sidecar を
  呼ばない。Codex hook は Codex runtime から Caveat CLI を直接呼ぶ経路として実装する。
- ここで禁止する silent fallback は「本来必要な経路が使えないのに、別経路で
  代用して成功扱いにすること」です。関連 caveat がない、または hook が発火条件を
  満たさない時に stdout を出さない quiet no-op は許容します。

## 実装方針

既存の Claude hook adapter の横に、Codex hook adapter を追加します。

```text
caveat codex-hook user-prompt-submit
caveat codex-hook post-tool-use
caveat codex-hook stop
caveat codex-hook worker <workFile>
caveat codex-hook diagnostics
```

Codex hook config に書く command は、Claude install と同じく `nodePath` と
`cliScriptPath` の absolute path を基本にします。hook 実行環境の `PATH` に
`caveat` command がある前提へ寄せると、global npm install / local checkout /
Codex App Server の起動環境差で壊れやすいためです。

共有できる中核処理は共有します。

```text
Claude payload parser -> shared Caveat hook logic -> Claude stdout formatter
Codex payload parser  -> shared Caveat hook logic -> Codex stdout formatter
```

adapter 境界に閉じ込める差分:

- hook input JSON の parse
- tool response / error の抽出
- session / transcript signal の抽出
- stdout JSON / context の format
- install 先と config file の形

Codex では、config 上の hook key と runtime payload / app-server schema 上の
event 名が同じ表記とは限りません。現時点では schema 上の event 名として
`userPromptSubmit` / `postToolUse` / `stop` を確認していますが、設定 file で
使う key が `UserPromptSubmit` なのか `userPromptSubmit` なのかは Phase 0 で
実測して決めます。この文書では、runtime event 名は lower camel、設定候補名は
capture TODO 内で明示的に検証対象として扱います。

## 未確定事項

- [x] Codex `userPromptSubmit` の stdin JSON は具体的にどんな形か。
- [x] Codex `postToolUse` の stdin JSON は成功時・失敗時でどう違うか。
- [x] Codex `stop` の stdin JSON は具体的にどんな形か。
- [x] どの stdout field が次の Codex turn へ context を注入するか。
- [x] `stop` は `{"decision":"block","reason":"..."}` を使わず、pending reminder に積んで
      次の `UserPromptSubmit` で drain する。実 UI で Stop block が最終回答を折り畳み表示へ
      巻き込むため。
- [ ] warning / hook failure 用 stdout field の詳細は Caveat の現行 3 hook では未使用。
- [ ] `postToolUse` は Codex の全 tool 種別で発火するのか、現行 build では
      local shell / command execution に限定されるのか。
- [x] `stop` payload だけで十分な session evidence が取れるのか、
      `~/.codex/sessions/*.jsonl` を読む必要があるのか。
- [x] Codex hook config は user-level `~/.codex/hooks.json`、project-level
      `.codex/hooks.json`、config-layer file のどれを読むのか。
- [x] Codex hook config の event key は `UserPromptSubmit` 形式か
      `userPromptSubmit` 形式か、それとも両方を受けるのか。
- [ ] hook config 変更は hot reload されるのか、新しい Codex session が必要か。
- [x] context injection できる hook event はどれか。`postToolUse` stdout が
      context 注入できない場合、pending reminder をどの正規 hook event で drain
      すべきか。
- [x] Codex の pending reminder を session ごとに分離するための stable key は何か。
      `session_id`、`sessionId`、`thread_id`、`turn_id` のどれが session 境界として
      使えるか、payload と session log の両方で確認する。cwd 由来の代用 key は
      session 混線を起こすため使わない。
- [x] 隔離 `CODEX_HOME` で Codex session を起動する時、auth material をどう扱うか。
      `codex exec --help` では `--ignore-user-config` を使っても auth は
      `CODEX_HOME` を見るため、config だけ隔離しても未ログインになる可能性がある。

## Phase 0: Payload Capture

目的: 推測ではなく、実際の Codex hook payload を fixture 化する。

- [x] release path の外に、一時的な capture hook script を作る。
- [x] まず `CODEX_HOME` を一時ディレクトリに向け、実ユーザー設定を触らない
      隔離 capture 環境を作る。
- [x] 隔離 `CODEX_HOME` は permission `0700` 相当にし、終了時に削除する。
- [x] auth が必要な smoke は、実 `~/.codex/auth.json` 等を repo にコピーしない。
      必要なら隔離 `CODEX_HOME` 内へ一時 symlink / copy するが、fixture 化せず、
      capture 終了後に削除する。auth material を扱えない環境では manual smoke を
      `skipped: auth unavailable` として明示する。
- [x] 隔離 `CODEX_HOME/config.toml` で`hooks`を有効化する（当時の
      `codex_hooks` aliasは0.16.1で移行）。
- [x] 隔離 hook config に `UserPromptSubmit` / `PostToolUse` / `Stop` 形式と
      `userPromptSubmit` / `postToolUse` / `stop` 形式を段階的に登録し、どちらが
      読まれるか確認する。
- [x] 可能なら `codex exec --json` を使い、TUI 操作に依存しない fresh Codex session
      を隔離 `CODEX_HOME` で起動する。session log が必要な `stop` smoke では
      `--ephemeral` を使わない。
- [x] 既存 Caveat に hit しそうな語を含む prompt で `userPromptSubmit` を
      発火させる。
- [x] 成功する tool 実行で `postToolUse` を発火させる。
- [x] 失敗する tool 実行で `postToolUse` を発火させる。
- [x] `stop` を発火させる。
- [x] `postToolUse` capture prompt は、`pwd` などの成功 command と、存在しない
      command などの失敗 command を要求する最小 prompt にする。model が tool を
      呼ばない場合は hook 未発火を failure と断定せず、`inconclusive: tool not invoked`
      として記録する。
- [x] sanitize 済み payload fixture を parser owner に合わせた場所へ保存する。
      parser を CLI 層に置くなら `apps/cli/tests/fixtures/codex-hooks/`、core 層に
      置くなら `packages/core/tests/fixtures/codex-hooks/` に置く。
- [x] 各 hook で stdout による context injection が効くか、hook prompt fragments
      または session item として観測できるか記録する。
- [x] `postToolUse` stdout が context injection できない場合、pending reminder
      を次の `userPromptSubmit` / `stop` / その他の Codex-supported context hook
      で drain する正規経路を決める。
- [x] 隔離環境で必要な挙動を確認できたため、実 `~/.codex/hooks.json` を
      触る compatibility pass を別手順として実施する。その場合は必ず事前 backup
      と事後 restore を行う、という条件を維持した。

受け入れ条件:

- [x] 対象 3 event すべての fixture が存在する。
- [x] fixture に secret、token、commit すべきでない user prompt、過度に private
      な absolute path が含まれていない。
- [x] adapter 設計が binary strings ではなく、capture 済み payload に基づいて
      書かれている。
- [x] 実ユーザーの `~/.codex` を触らずに payload capture できる。触る必要が
      あった場合は、その理由と backup / restore 結果が記録されている。
- [x] hook config key と runtime event 名の対応が fixture または capture log に
      記録されている。
- [x] auth material が repo、fixture、test snapshot、stdout/stderr log に残って
      いないことを確認している。

## Phase 1: Shared Hook Core

目的: Caveat hook 実装を Claude 用と Codex 用に二重化しない。

- [ ] `apps/cli/src/commands/hookCmd.ts` 内の Claude 固有処理を特定する。
- [ ] prompt search orchestration を共有 helper に抽出する。
- [ ] pending reminder の drain / append を、必要なら共有 helper に整理する。
- [ ] pending reminder は text queue として維持し、stdout wrapper は host-specific
      formatter で付ける。Claude drain では `<system-reminder>`、Codex drain では
      Phase 0 で確認した Codex-visible format を使い分ける。
- [ ] `getSessionId` 相当を Claude / Codex adapter ごとに分ける。Codex 側は Phase 0 で
      確認した stable key が取れない場合、pending を enqueue せず diagnostics / stderr で
      理由を出す。
- [ ] tool-error reminder 生成を payload-neutral な helper に抽出する。
- [ ] Claude command 名と output を変更しない。
- [ ] 既存 Claude hook output が変わっていないことを示す regression test を
      追加する。

受け入れ条件:

- [ ] 既存 Claude hook tests が snapshot churn なしで通る。
- [ ] 共有 helper を Claude / Codex adapter の両方から呼べる。
- [ ] Codex の都合で Claude-facing field name や hook 文言が変更されていない。

## Phase 2: Codex UserPromptSubmit

目的: Codex が作業を始める前に、既存 caveat を浮上させる。

- [x] Codex `userPromptSubmit` payload parser を追加する。
- [x] Codex prompt text を既存の `findCaveatsForPrompt` に渡す。
- [x] capture した context-injection contract に従って Codex stdout を format
      する。
- [x] Claude と同様、hook 冒頭で pending reminder を drain する。ただし wrapper は
      Codex formatter を使い、Claude の `<system-reminder>` をそのまま出さない。
- [x] capture fixture を使った unit test を追加する。payload parser を CLI 層に
      置くなら fixture は `apps/cli/tests/fixtures/codex-hooks/`、core 層に置くなら
      `packages/core/tests/fixtures/codex-hooks/` に置く。
- [x] 返した context が Codex に見えている、または hook prompt fragments に
      入っていることを smoke test で確認する。

受け入れ条件:

- [ ] 既存 caveat に match する prompt で Codex-visible context が出る。
- [ ] 関連 caveat がない prompt では静かに終了する。
- [ ] DB がない / index が壊れている場合も crash せず、明示的に扱う。

## Phase 3: Codex PostToolUse

目的: Codex でも、実行中の tool error を Caveat が拾えるようにする。

- [x] Codex `postToolUse` payload parser を追加する。
- [x] capture payload から信頼できる error signal を決める。
- [x] 可能な限り prose scraping ではなく、構造化 field から failed tool output
      を抽出する。
- [x] pending reminder 経路を再利用する。実 Codex では detached child が残らない
      smoke 結果だったため、Codex `PostToolUse` は前景 hook 内で bounded lookup し、
      pending file を書き切る。
- [x] `postToolUse` stdout が Codex-visible context にならない場合は、Phase 0 で
      確認した context-capable hook event へ pending reminder を渡す設計にする。
      context-capable event が見つからない場合は実装を止め、設計判断を求める。
- [x] Codex 用に worker payload shape を分ける必要があれば
      `caveat codex-hook worker <workFile>` を追加する。
- [x] worker job には host agent / formatter 種別を含めるか、Codex 専用 worker entry を
      分ける。Codex の tool error から作った pending reminder が Claude 用 wrapper で
      drain されないことを test で固定する。
- [ ] success、missing text、malformed payload の unit test を追加する。
- [x] captured failure payload の unit test を追加する。
- [x] tool failure を 1 回起こし、Phase 0 で確認した context-capable な後続 hook
      tick で pending reminder が drain されることを integration smoke で確認する。
      この smoke は Codex auth / network / model 実行に依存するため、通常 CI の
      unit test には入れず、manual e2e または明示 opt-in test として扱う。

受け入れ条件:

- [ ] 成功した tool では error reminder を生成しない。
- [x] 失敗した tool では Codex `PostToolUse` が pending reminder を enqueue
      する。Codex では exit code が stdin に無いため、既存 Caveat symptom に当たる
      `tool_input` / `tool_response` に限定して扱う。
- [x] Phase 0 で確認した context-capable hook tick で pending reminder が
      Codex-visible context に出る。

## Phase 4: Codex Stop

目的: Codex でも、turn 終了時の苦戦検出と record/update 誘導を維持する。

- [x] Codex `stop` payload だけで `readSessionSignals` 相当の evidence が
      足りるか確認する。
- [x] 必要なら Codex session JSONL signal reader を追加し、diagnostics で検査
      できるようにする。
- [x] Codex における tool failure、repeated command、repeated edit、web search、
      web fetch 相当を Caveat の signal model に mapping する。
- [x] Claude 文言を変えずに、可能な範囲で `stopReminderText` の意味論を再利用
      する。
- [x] Codex `Stop` は block formatter を使わず、session pending reminder に enqueue
      して次の `UserPromptSubmit` で Codex-specific context formatter から drain する。
- [x] Codex `Stop` は同じ session / 同じ signal digest を再 enqueue しない。
- [ ] no-signal、failure-signal、repeated-command、related caveat search の test
      を追加する。
- [x] web search / web fetch 相当の signal test を追加する。

受け入れ条件:

- [ ] 苦戦シグナルがなければ record/update reminder を出さない。
- [x] 客観的な苦戦シグナルが 1 つ以上あれば reminder を pending queue に積む。
- [ ] co-occurrence search で関連 caveat が見つかれば reminder に埋め込む。
- [ ] Codex session log が必要なのに読めない場合、diagnostics が理由を出す。

実機確認 (2026-05-06):

- `~/.codex/hooks.json` の `Stop` が
  `/usr/bin/node /home/kite/.npm-global/bin/caveat codex-hook stop` を呼ぶ状態で確認した。
- `rtk proxy /usr/bin/node /home/kite/.npm-global/bin/caveat codex-hook diagnostics` で
  当時の`codex_hooks: enabled`（現行名`hooks`）、`installation: installed`、`stop: true` を確認した。
- 失敗 tool output を含む transcript で `codex-hook stop` を直接実行し、status 0、
  stdout 0 bytes、stderr 0 bytes を確認した。Stop は
  `{"decision":"block","reason":"..."}` を返さない。
- 同じ `session_id` の次の `codex-hook user-prompt-submit` で
  `hookSpecificOutput.additionalContext` として Stop reminder が出力され、さらに次の
  `UserPromptSubmit` は空になった。pending reminder は一度だけ drain される。
- nested `codex exec --json` で失敗 command 後に Stop を発火させた session log では、
  最終回答 `done` が通常の `agent_message` / `task_complete.last_agent_message` として
  記録された。該当 session transcript に `blocked` / `decision` は出ていない。
- 追加 smoke では、新規 `codex exec` session で tool failure を起こした後、
  `codex exec resume --last` の次 turn transcript に Stop reminder が `developer`
  message として注入されること、stderr に `invalid user prompt submit JSON output` が
  出ないこと、同じ Stop signal が resume 終了時に再 enqueue されないことを確認した。

## Phase 5: Codex Hook Install and Diagnostics

目的: 手作業で config を編集しなくても使えるようにする。

- [x] `caveat codex-hook diagnostics` を追加する。
- [x] `codex` binary が利用可能か確認する。
- [x] `codex features list` に enabled な `hooks` があるか確認する。
      表示形式が安定しない可能性があるため、diagnostics は raw evidence を併記し、
      1 つの brittle string match だけで `operational` 判定しない。
- [x] 想定 hook config path を確認する。
- [x] user-level `~/.codex/hooks.json` と project-level `.codex/hooks.json` の
      どちらを正式 install target にするか、Phase 0 の検証結果に基づいて決める。
- [x] 正式 install target と、もう一方を扱う場合の挙動を docs に明記する。
- [ ] hook command が実行可能か確認する。
- [x] install path はまず `caveat codex-hook install` として追加する。
      `caveat init --codex` を後で足す場合も explicit opt-in にし、既存 `caveat init` の
      default behavior は変えない。
- [x] install config には absolute `nodePath` + `cliScriptPath` command を書き、
      `PATH` 最小環境でも hook command が動くことを test する。
- [x] Codex hook config を書き換える前に backup を作る。
- [x] Caveat 以外の Codex hooks を保持する。
- [x] install を冪等にする。
- [x] Caveat が追加した Codex hooks だけを消す uninstall を追加する。

受け入れ条件:

- [ ] install が既存の unrelated hooks を消さずに Caveat hooks を追加する。
- [ ] 2 回目の install で重複追加されない。
- [ ] uninstall が Caveat-owned hooks だけを削除する。
- [x] diagnostics が availability と installation を分けて明示する。

Hook diagnostics の状態名は codex-sidecar の availability とは別物として定義する。
`config missing` は、それだけでは `unavailable` ではない。hook config path を解決
でき、必要なら作成できるなら、Codex hook runtime は利用可能だが Caveat hook は
未 install と扱う。

Availability:

| 状態 | 意味 |
|---|---|
| `unavailable` | `codex` binary がない、`hooks` featureが使えない、または hook config path を解決/作成できない |
| `available` | hook config path と command は作れるが、実 hook 発火 smoke は未確認 |
| `operational` | 隔離環境または明示した実環境で、対象 hook の発火と、その hook が担う Caveat behavior の delivery smoke が成功。`postToolUse` は直接 stdout injection ではなく、後続 context-capable hook での pending drain 成功でもよい |

Installation:

| 状態 | 意味 |
|---|---|
| `not-installed` | Caveat-owned Codex hooks がまだ入っていない。config file が未作成でもここに含める |
| `installed` | Caveat-owned Codex hooks が期待通り入っている |
| `partial` | 一部だけ入っている、古い command を指している、または expected hook set と差分がある |

## Phase 6: Documentation and Release

目的: この対応を理解・保守・release できる状態にする。

- [x] `docs/03_dual_agent_support.md` に Codex hook adapter note を追加する。
- [ ] user-facing install behavior が変わる場合のみ、`README.md` /
      `README.ja.md` を更新する。
- [ ] Claude contract 自体が変わる場合のみ `CLAUDE.md` を更新する。
- [ ] changelog entry を追加する。
- [x] Codex hook contract に非自明な罠があれば Caveat knowledge として登録する。
- [ ] full test suite を実行する。
- [x] Codex hook diagnostics を実行する。
- [x] Codex hook の発火 smoke は、auth / network / model 実行が必要なら manual e2e
      として実行し、unit test 必須条件にはしない。
- [ ] manual e2e が auth 不足や model が tool を呼ばない理由で skip / inconclusive の
      場合、release note では `operational` と書かず、fixture-based support と
      diagnostics までの到達として明記する。
- [x] installed package path を検証してから publish する。

受け入れ条件:

- [x] docs が Codex hooks を supported-but-underdocumented と明記している。
- [ ] Caveat の Claude behavior が canonical かつ unchanged のまま。
- [ ] release notes が Codex hook support を rewrite ではなく adapter として説明
      している。

## Test Matrix

| 領域 | Test |
|---|---|
| Payload parsing | 3 hook すべての captured fixture tests |
| Prompt search | 既存 caveat hit、no hit、malformed DB |
| Pending reminders | append、drain、missing session id、worker failure |
| Tool error extraction | success、failure、empty output、large output |
| Stop signals | no signal、tool failure、repeated command、repeated edit、web search、web fetch |
| Install | new config、existing unrelated hooks、idempotent reinstall、uninstall |
| Hook command | absolute node/CLI path、PATH-minimal environment、env-prefixed command equivalence |
| Diagnostics | no codex binary、hooks disabled、config missing but creatable、hooks installed、hooks partial、hooks operational |
| Regression | 既存 Claude hook tests unchanged |
| Manual e2e | isolated `CODEX_HOME` with auth, `codex exec --json`, real hook firing, no auth leakage |

## Risks

- Codex hook docs が実装より遅れている可能性がある。
  対策: diagnostics と fixture-based tests を compatibility boundary にする。
- Codex session JSONL の形が変わる可能性がある。
  対策: まず hook payload field を優先する。JSONL が必要なら Codex reader に
  隔離し、読めない時は明示的に失敗させる。
- hook stdout contract が Claude の `<system-reminder>` と異なる可能性がある。
  対策: capture した stdout behavior に基づく Codex formatter を用意する。
- hook config discovery が CLI と IDE / app-server session で違う可能性がある。
  対策: diagnostics で active config layer を報告する。
- 隔離 `CODEX_HOME` は auth も隔離するため、実 Codex session smoke が未ログインで
  失敗する可能性がある。
  対策: auth material を repo に入れず、permission を絞った一時 `CODEX_HOME` へ
  一時的に渡す。渡せない環境では manual e2e を明示 skip し、fixture unit test と
  diagnostics で実装を進める。
- `codex exec --json` の manual e2e で model が期待した tool を呼ばず、`postToolUse`
  が発火しない可能性がある。
  対策: e2e prompt は最小 command 実行に寄せるが、発火しない場合は inconclusive と
  して記録する。parser / formatter / pending queue の正しさは captured fixture tests
  を主根拠にする。

## Done Definition

- [ ] Codex `userPromptSubmit` が、作業前に match した Caveat entries を浮上
      できる。
- [ ] Codex `postToolUse` が tool error を拾い、context-capable な後続 hook tick で
      async reminder を drain できる。
- [ ] Codex `stop` が客観的な苦戦シグナルを検出し、record/update を促せる。
- [ ] 既存 Claude hook behavior が変わっていない。
- [ ] Codex install / uninstall が unrelated hooks を保持する。
- [ ] diagnostics が unsupported Codex environment を hidden fallback なしに説明
      できる。
- [ ] docs が adapter 境界と、Codex hook surface がまだ文書化薄めであることを
      説明している。
