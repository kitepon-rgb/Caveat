# Proposal execution provenance 調査

出典・取得日・確度:

- [OpenAI Codex developer commands](raw/openai-codex-developer-commands.md) — 2026-07-13、confirmed
- [Anthropic Claude Code CLI reference](raw/anthropic-claude-code-cli.md) — 2026-07-13、confirmed
- [OpenAI Codex JSONL event types](raw/openai-exec_events.rs.md) — 2026-07-13、confirmed
- [OpenAI Codex JSONL event processor](raw/openai-event_processor_with_jsonl_output.rs.md) と
  [tests](raw/openai-event_processor_with_jsonl_output_tests.rs.md) — 2026-07-13、confirmed
- [Anthropic Claude Agent SDK TypeScript types 0.3.207](raw/anthropic-agent-sdk-types.md) — 2026-07-13、confirmed
- ローカル実測 `codex-cli 0.144.1` / `Claude Code 2.1.207` の `--help` — 2026-07-13、confirmed

## 設計へ採用する事実

- Codex は `codex exec --json` で非対話実行の状態変化を JSONL へ出せる。`--model`、`--sandbox`、`--ephemeral`、`--ignore-user-config` を明示できる。
- Claude Code は `-p --output-format stream-json` で非対話実行でき、`--model`、`--tools`、`--permission-mode`、`--no-session-persistence` を明示できる。ローカル版には個人カスタマイズを抑える `--bare` もある。
- Codex JSONL は `thread.started`、item、turn終端を型付きで出し、turn itemsの末尾側にある
  `agent_message` を最終回答として扱う。一方、実効model名は公開JSONL eventに含まれないため、
  指定値を報告値にすり替えず `requested_only` と記録する。
- Claude stream-json は `system/init` にmodel、assistant messageにmodel、terminal resultに
  `modelUsage` と `permission_denials` を持つ。Claude Code 2.1.205 + `claude-sonnet-5` の
  2026-07-13実測では、応答assistantがSonnet 5だけでも`modelUsage`に内部補助Haikuが併記され、
  thinking使用時は`system/thinking_tokens`、subscription状態は`rate_limit_event`で通知された。
  initと全assistantが要求modelに一致し、要求modelのusage keyも存在するときだけ
  `provider_reported` とする。補助usage keyの存在だけではmodel mixing扱いにしない。
- Claude Code 2.1.207の`--json-schema`はroot objectを要求し、成功時は内部
  `StructuredOutput` tool_use、対応user/tool_result、terminalの`structured_output`と`result`を
  出す。通常executionのtool禁止parserは緩めず、masked judge専用validatorだけがtool名・ID・
  入力・result三者の完全一致を検証して許可する。array rootはprovider 400、promptだけのJSON指定は
  markdown fenceを安定して付けるため採用しない。
- CLI の session/thread ID は追跡識別子であり、provider署名付きの暗号学的 receipt ではない。execution harness が生成した canonical request、CLI引数、raw response の digest と一緒に保存する。

## 限界

- Codex event schemaは公式実装／公開SDK型とsynthetic fixtureで固定した。Claude側は
  local-only raw judge stream（0600、digest
  `4d439fd89f3ad203a28c7d6d80866c3cbacd0750ae49622e8b8bbda0bff57144`ほか）で
  Claude Code 2.1.205 / Sonnet 5との適合も確認した。raw本文はmasked評価出力を含むためragへ複製しない。
- OpenAI Codex manual helper は公式応答に `x-content-sha256` がなく失敗した。未検証本文へ降格せず、公式 Docs MCP と公式ページの MarkItDown 取得へ切り替えた。

## 初回behavioral characterization（2026-07-13）

全文会話ではなく許可判断に必要なbounded excerpt 1 scenarioを、`gpt-5.6-sol`と
`claude-sonnet-5`で各4 run（control/caveat各2）実行した。8/8 completed、masked Sonnet 5
judgeで両host・両conditionともknown-bad 0/2、valid solution 2/2、safe-and-useful 2/2となり、
全rate differenceは0だった。controlが既に完全だった天井効果なので、害は観測されなかったが
Caveatの増分効果も観測されていない。1 scenario・各condition n=2のため一般化しない。

正本artifactはlocal-only
`~/.caveat-p4-latest/local-eval/proposal/characterization-summary.json`、suite digestは
`512f600230e4823cbf95f463da2bcfe7fc817f48a6920f1616bdc3771d9bdc95`。
旧`~/.caveat/local-eval/proposal` batchはClaude Sonnet 4.6を使いClaude 4/4 nonzeroだったため、
preliminary/excludedとする。
