# Caveat Dual-Agent Support

This document is additive to `CLAUDE.md`. `CLAUDE.md` remains the canonical
description of Caveat's existing Claude Code behavior.

## Current Claude Contract

Caveat's Claude integration is unchanged by Codex sidecar support.

- CLI install command: `caveat init [--skip-claude] [--dry-run]`
- CLI uninstall command: `caveat uninstall [--dry-run]`
- MCP command registered for Claude: `caveat mcp-server`
- Hook command shape: `caveat hook <name> [arg]`
- Hook names: `user-prompt-submit`, `post-tool-use`, `stop`, `worker`
- Claude settings targets:
  - MCP is registered through `claude mcp add --scope user caveat -- ...`
  - Hooks are merged into `~/.claude/settings.json`
- Hook stdout contract:
  - Emits zero or more `<system-reminder>...</system-reminder>` blocks
  - Logs diagnostics to stderr with `[caveat:hook]`
- Stop-hook recursion guard: `payload.stop_hook_active === true` exits silently
- PostToolUse async behavior:
  - Foreground hook drains pending reminders
  - Tool errors enqueue detached worker inspection
  - Worker writes reminders under Caveat pending storage for the next hook tick
- Markdown entry contract:
  - Frontmatter is parsed with `gray-matter` and `js-yaml` `JSON_SCHEMA`
  - Canonical fields are the `Frontmatter` type in `packages/core/src/types.ts`
  - Body sections are `##` headings parsed by `extractSections`
- File convention:
  - Own entries live under `entries/**/*.md`
  - Community entries live under `community/<handle>/entries/**/*.md`

Codex support must not rename these fields, rewrite hook text, or replace Claude
commands. Codex receives an adapter output derived from the same entry.

## Codex Adapter

`@caveat/core` exposes `caveatEntryToSidecarContextBlock(entry)`, which converts
a `GetResult` into a plain JSON context block:

```json
{
  "kind": "caveat_entry",
  "source": "caveat",
  "trust": "local",
  "summary": "Short warning derived from title and Symptom.",
  "references": [{ "path": "entries/example.md", "label": "source caveat" }],
  "data": {
    "id": "example",
    "source": "own",
    "title": "Example caveat",
    "tags": ["mcp"],
    "confidence": "confirmed",
    "visibility": "public",
    "environment": {}
  }
}
```

The adapter is intentionally separate from Claude hooks and MCP tools. Claude
continues to consume Caveat through reminders and the Caveat MCP server; Codex
can consume `caveat_entry` blocks through `codex-sidecar`.

`codex-sidecar` accepts these blocks from both integration surfaces:

- CLI: `--context-file <json>`
- MCP: `context: [...]` tool input

## Execution Policy

`decideCodexSidecarExecution` prevents accidental recursive delegation.

| Host agent | Policy |
|---|---|
| Claude | Prefer operational Codex sidecar for independent review, exploration, opinion, and risk-check tasks. |
| Codex | Use Codex sidecar only when there is a clear boundary: isolated worktree, structured result, explicit second pass, or risk/review role separation. |
| Automation / unknown | Require explicit `sidecar_agent: codex` before delegation. |

Availability levels:

| Level | Meaning |
|---|---|
| `disabled` | Sidecar is intentionally off. |
| `unavailable` | Sidecar is absent, cannot run, or diagnostics failed. |
| `configured` | Diagnostics can be shaped and attempted, but read-only smoke has not succeeded. |
| `operational` | Read-only smoke succeeded. |
| `work-capable` | `codex_work` smoke succeeded and allowed paths are configured. |

`codex_work` requires `work-capable`. Read-only review/explore/opinion/risk-check
requires `operational` or `work-capable`.

## Smoke Commands

Preferred installed-path diagnostics:

```bash
caveat codex-sidecar diagnostics --project /path/to/repo --preset review
```

Development-path diagnostics:

```bash
caveat codex-sidecar diagnostics \
  --project /path/to/repo \
  --preset review \
  --node-cli /home/kite/projects/codex-sidecar/packages/cli/dist/index.js
```

Read-only operational smoke:

```bash
caveat codex-sidecar smoke \
  --project /path/to/repo \
  --node-cli /home/kite/projects/codex-sidecar/packages/cli/dist/index.js
```

These commands do not silently substitute another sidecar path. The selected
command is printed before execution.

Work-capable smoke:

```bash
caveat codex-sidecar work-smoke \
  --project /path/to/repo \
  --node-cli /home/kite/projects/codex-sidecar/packages/cli/dist/index.js
```

This runs `codex_work` in an isolated git worktree and passes
`--remove-worktree`; the real repository should not receive the smoke edit. A
successful result reports `worktreePreserved: false` and a `changedFiles` list
containing only allowed paths.

## Caveat Context Routing

The read-only routing path is:

```text
Caveat DB search
  -> full Caveat entries
  -> caveat_entry context blocks
  -> temporary context JSON file
  -> codex-sidecar --context-file
  -> structured SidecarResult
```

CLI form:

```bash
caveat codex-sidecar run explore \
  "Use the provided Caveat context to answer this question." \
  --query "Claude Code hooks settings reload" \
  --limit 5 \
  --host-agent claude \
  --node-cli /home/kite/projects/codex-sidecar/packages/cli/dist/index.js
```

Supported read-only workflows are `review`, `explore`, `opinion`, and
`risk-check` (`risk` is accepted as an alias for `risk-check`). The command
marks surfaced Caveat entries as retrieval hits, writes only a temporary context
file, and removes that file after the sidecar process exits.

When policy says not to call Codex sidecar, the command prints an explicit
`skipped` decision instead of silently falling back:

```json
{
  "status": "skipped",
  "decision": {
    "route": "claude-compatibility",
    "reason": "codex-sidecar is not available for this repository."
  }
}
```

For Codex-hosted sessions, `caveat codex-sidecar run ... --host-agent codex`
will skip unless the call declares a real boundary, such as
`--structured-result-required`, `--explicit-second-pass`, or
`--requires-isolation`.

## Result Handling

`codex-sidecar` returns a structured `SidecarResult` JSON object. Caveat does
not need prose scraping to consume or persist the result.

Any Caveat sidecar command can write the structured result to disk:

```bash
caveat codex-sidecar run risk-check \
  "Check the MCP and hook changes." \
  --query "mcp hooks secrets" \
  --host-agent claude \
  --save-result .codex-sidecar/results/risk-check.json
```

The saved file is parsed and re-serialized JSON from sidecar stdout. The
`rawEventLogRef` field, when present, points at the durable App Server event log
under `.codex-sidecar/logs/app-server`.

## Background Task Audit

The current Caveat codebase does not contain a runtime path that calls a Claude
subagent API for background review or audit work. The existing background
behavior is the `PostToolUse` detached worker:

```text
Claude PostToolUse hook
  -> detached Caveat worker
  -> Caveat DB search
  -> pending reminder for the next hook tick
```

That worker is tied to Claude hook timing and Claude tool-response payloads, so
it remains Claude-primary. When `codex-sidecar` is operational, the worker can
append a Codex advisory to the same pending reminder. The original Caveat
reminder remains first and unchanged; the Codex text is a second opinion for
Claude, not a new Caveat decision engine.

`Stop` hook reminders follow the same rule. The existing signal-gated
`stopReminderText` still decides whether Caveat should speak. If it speaks and
`codex-sidecar` is enabled, Caveat appends Codex advice about whether Claude
should update an existing caveat or record a new one.

Independent review, exploration, opinion, risk-check, and scoped work also have
Codex sidecar routes through the commands above.

## Hook Codex Advisory

Hook advisory is controlled by environment variables and is explicit about
availability:

| Variable | Values | Default | Meaning |
|---|---|---|---|
| `CAVEAT_HOOK_CODEX_SIDECAR` | `off`, `auto`, `require` | `auto` | Controls whether hooks ask Codex for a second opinion. |
| `CAVEAT_CODEX_SIDECAR_NODE_CLI` | path | unset | Development path to a built `codex-sidecar` CLI. |
| `CAVEAT_CODEX_SIDECAR_COMMAND` | command | unset | Installed command to run instead of the default `codex-sidecar`. |
| `CAVEAT_HOOK_CODEX_SIDECAR_TIMEOUT_MS` | milliseconds | `120000` | Maximum time for the hook-side advisory call. |

`auto` only attempts the advisory when the current project has
`.codex-sidecar.yml`. `off` preserves the pre-Codex hook behavior. `require`
attempts the advisory even without a project config and appends an explicit
`[caveat:codex-sidecar] advisory unavailable: ...` line if it cannot run.

The hook path uses:

```text
caveat hook post-tool-use / stop
  -> existing Caveat DB search and reminder construction
  -> caveat codex-sidecar run explore --host-agent claude --availability operational
  -> optional [caveat:codex-sidecar] Codex advisory appended to the reminder
```

This is not a hidden fallback. If the advisory path was requested and fails,
the reminder says so. If `auto` sees no sidecar config, Caveat emits only the
existing reminder text.
