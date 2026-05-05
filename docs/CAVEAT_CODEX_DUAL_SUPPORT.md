# Caveat: Claude / Codex 両対応計画

この文書は Caveat repository に貼り付けるための実装ブリーフです。目的は、Caveat を Claude Code と Codex の両方から安全に使える形へ育てることです。

## 目標

Caveat は agent-neutral な memory infrastructure になるべきです。

Claude での既存動作はそのまま維持しつつ、repo-specific gotcha、trap、caveat、verification hint を `codex-sidecar` 経由で Codex にも渡せるようにします。

目指す形:

- Caveat core は特定 agent に依存しない。
- Claude integration は first-class のまま維持する。
- Codex integration は rewrite ではなく adapter として追加する。
- 既存の Claude command、hook、markdown format、workflow を壊さない。

## 優先順位

1. この project 内で background Claude subagent が担っている作業を、適切な範囲で Codex sidecar に移す。
2. その次に、Caveat 本体を Claude だけでなく Codex にも対応させる。

最初にやるべきことは「Caveat を Codex 用に書き換える」ことではありません。まず、現在 Claude subagent に委譲している background task を洗い出し、second opinion、review、risk-check、scoped work に向いたものを `codex-sidecar` へ routing します。

runtime environment で Codex が使えない場合は、現在の Claude subagent behavior をそのまま維持します。Codex adapter が存在するからといって、既存の Claude path を削ったり劣化させたりしないでください。

## Architecture 方針

概念上、次の layer に分けます。

| Layer | Responsibility |
|---|---|
| Agent-neutral core | Caveat entry、markdown-in-git storage、parsing、lookup、indexing、validation |
| Claude adapter | Claude Code command、hook、transcript 前提、Claude-facing prompt |
| Codex adapter | `caveat_entry` context block、`codex-sidecar` request shaping、structured result handling |
| Shared fixtures | Claude / Codex adapter の両方で使う caveat entry 例と expected output |

「Claude Caveat」と「Codex Caveat」に分岐させないでください。Caveat core は 1 つに保ち、複数の agent adapter を持つ形にします。

## Codex Sidecar Integration

Codex 向けには、Caveat が `codex-sidecar` contract に合う plain JSON context block を生成します。

```json
{
  "kind": "caveat_entry",
  "source": "caveat",
  "trust": "local",
  "summary": "Short gotcha or repository-specific warning.",
  "references": [
    {
      "path": "docs/caveats/example.md",
      "line": 12,
      "label": "source caveat"
    }
  ],
  "data": {
    "tags": ["oauth", "mcp", "secrets"],
    "severity": "high"
  }
}
```

Codex-facing workflow では、この context block を次の用途に使います。

- `codex_review`: diff review の前に関連 caveat を渡す。
- `codex_explore`: codebase question に答えるときの local memory として caveat を渡す。
- `codex_risk_check`: OAuth、MCP、secrets、hooks、Docker、CI、deploy surface の high-severity caveat を渡す。
- `codex_work`: caveat を渡しつつ、書き込みは sidecar worktree の中に閉じ込める。

## Claude Behavior を守る

コード変更の前に、現在の Claude contract を特定して文書化してください。

- command name と command argument
- hook input / output
- markdown entry format
- file naming convention
- expected frontmatter field
- transcript / tool-output assumption
- Claude behavior を表す test / fixture

明示的な migration plan がない限り、Codex 対応は additive にしてください。

Claude が読んでいる field name を Codex のために rename しないでください。必要なら新しい adapter output を追加します。

## Background Subagent Shift

Caveat が現在 background Claude subagent に memory inspection、entry audit、change review、repo risk-check などを任せている場合、task が自然に独立しているなら `codex-sidecar` 経由に寄せます。

Codex sidecar に向いている task:

- proposed caveat への second opinion
- known caveat に基づく risk check
- caveat entry 変更の read-only review
- formatting / fixture issue の worktree-backed cleanup
- caveat から context block への structured extraction

Claude-specific transcript context や active conversation state に強く依存する task は、Claude primary のまま維持します。

## 懸念: Codex が Codex を呼ぶ場合

ユーザーが Claude から Caveat を使っている場合、この形には価値があります。

```text
Claude primary -> Caveat -> codex-sidecar -> Codex second opinion
```

一方、ユーザーが Codex から Caveat を使っている場合、次の形を無条件で行わないでください。

```text
Codex primary -> Caveat -> codex-sidecar -> Codex again
```

Codex-on-Codex が有効なのは、sidecar に明確に別の境界がある場合だけです。

- `codex_work` の isolated git worktree
- structured output を伴う read-only review / risk check
- critic、reviewer、risk analyst など異なる prompt role
- 異なる model / profile / cost policy
- app が必要とする durable raw event log と `SidecarResult`

別の境界がないなら、Caveat は「もう 1 つの Codex」を呼ぶためだけに Codex sidecar を使わないでください。その場合は現在の Codex session を直接使い、通常の Caveat flow で結果を記録します。

Recommended policy:

| Host agent | Sidecar choice |
|---|---|
| Claude | independent review、risk、exploration、scoped work には Codex sidecar を優先 |
| Codex | isolation、structured result、worktree execution、explicit second-pass review がある場合のみ Codex sidecar を使う |
| Unknown / automation | `sidecar_agent: codex`、`disabled`、将来の `auto` など明示 config を要求 |

Availability policy:

| Codex availability | Behavior |
|---|---|
| `unavailable` | `codex-sidecar` が存在しない、実行不能、この repo 向けに未設定、または diagnostics 失敗。既存の Claude subagent path を維持 |
| `configured` | `codex-sidecar diagnostics --project <repo>` が成功。request shaping、dry-run、docs、planned read-only integration は使ってよい |
| `operational` | `codex_explore` など read-only smoke が成功。approved review、explore、opinion、risk-check sidecar task に使ってよい |
| `work-capable` | `codex_work` smoke が成功し、allowed paths が設定済み。worktree-backed scoped edit に使ってよい |
| explicitly disabled | 既存の Claude subagent path を維持 |

これは hidden fallback ではありません。互換モードです。Codex が使えない環境では、現在の Claude-backed behavior を baseline とします。

「Codex が使える」の最小実用定義は、単に `codex` binary があることではありません。`codex-sidecar` が存在し、対象 repository で diagnostics を成功させられることです。`codex-sidecar` がない場合、Caveat は Codex unavailable と扱ってください。

Preferred health check:

```bash
codex-sidecar diagnostics --project <repo> --preset review
```

Development-path health check:

```bash
node /home/kite/projects/codex-sidecar/packages/cli/dist/index.js diagnostics \
  --project <repo> \
  --preset review
```

## Implementation Checklist

- 既存の Claude command、hook、schema、fixture を audit する。
- adapter 変更前に、現在の Claude behavior を固定する test を追加する。
- `caveat_entry` 用の Caveat-to-`SidecarContextBlock` conversion path を追加する。
- Codex context block の fixture snapshot を追加する。
- Claude と Codex が同じ Caveat entry をどう consume するか docs に書く。
- 不要な Codex-on-Codex recursion を避ける execution policy を追加する。
- background Claude subagent task を移す前に Codex availability check を入れる。sidecar absent または diagnostics failure なら Claude subagent compatibility mode。
- `codex-sidecar` read-only workflow の smoke path を追加する。
- `codex_work` の変更は isolated worktree 内に閉じ込め、allowed paths を必須にする。

## Done Definition

Caveat が dual-supported になったと言える条件:

- 既存の Claude workflow が変更なしで通る。
- Codex が関連する `caveat_entry` context block を受け取れる。
- Codex result を prose scraping なしで保存または参照できる。
- host-agent policy が accidental recursive Codex delegation を防ぐ。
- Codex-unavailable environment では既存の Claude subagent behavior を維持する。
- Claude primary、Codex primary、automation mode の違いが docs に説明されている。
