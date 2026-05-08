# Next Session Handoff

Last updated: 2026-05-08.

## Status

All release work for `caveat-cli@0.14.7` and `codex-sidecar@0.3.0` is closed
out. No outstanding tasks at this time.

## 2026-05-08 Claude Smoke Rerun Result

The Claude generated-response smoke that was blocked by the 2026-05-06 rate
limit was rerun on 2026-05-08 18:27 JST and passed.

- Fresh global install of `caveat-cli@0.14.7` into a temporary `npm prefix`.
- `caveat init` wrote MCP + 4 hooks (`UserPromptSubmit`, `PostToolUse`,
  `PostToolUseFailure`, `Stop`) into the temp `$home/.claude/`.
- `claude -p` was run with the real `HOME` (so account auth resolved) but
  with `--settings` and `--mcp-config` pointing at the temp files. The temp
  HOME isolation in the original recipe broke auth (`Not logged in`); using
  real HOME plus explicit `--settings` / `--mcp-config` overrides keeps the
  isolation intent (no writes into real `~/.claude/`) while letting Claude
  read its credentials. This is the procedure to use for future reruns.
- `claude` exit code: `0`. Final stream `result.subtype: success`,
  `is_error: false`, `result: "caveat-claude-session-ok"`.
- Stream contained `caveat-claude-session-ok` (5 token occurrences across
  partial-message and final result frames).
- MCP `caveat` reported `status: "connected"` in the `system/init` frame
  with all 6 caveat tools listed.
- No `caveat.*(error|invalid|failed)` or `invalid.*caveat` lines in the
  stream.
- Closeout: `caveat-cli` latest tag = `0.14.7`, `codex-sidecar-cli` latest
  tag = `0.3.0`, latest two CI runs green, worktree clean.

## Original Current State (pre-smoke, retained for history)

Codex support is complete and released.

- `caveat-cli@0.14.7` is published to npm and tagged as `latest`.
- `codex-sidecar-core@0.3.0`, `codex-sidecar-cli@0.3.0`, and
  `codex-sidecar-mcp@0.3.0` are published to npm and tagged as `latest`.
- Caveat GitHub Release: <https://github.com/kitepon-rgb/Caveat/releases/tag/v0.14.7>
- codex-sidecar GitHub Release:
  <https://github.com/kitepon-rgb/codex-sidecar/releases/tag/v0.3.0>
- Caveat CI run `25431661576` is green across Ubuntu 24.04, Windows 2022,
  Windows 2025 with VS 2026, Node 22, and Node 24.
- codex-sidecar CI run `25431264843` is green.

The Codex path was verified from published packages:

- Fresh npm global install of `caveat-cli@0.14.7`.
- `caveat codex-hook install` and `caveat codex-hook diagnostics`.
- New `codex exec` session with Caveat hooks installed.
- Published `codex-sidecar-cli@0.3.0` advisory smoke from Caveat.
- Raw Codex App Server log verified `model="gpt-5.4-mini"` and
  `model_reasoning_effort="low"`.

## Only Remaining Task (resolved 2026-05-08)

Rerun the Claude generated-response smoke after the Claude account rate limit
resets. This is not a Caveat failure. **Resolved on 2026-05-08 — see "2026-05-08
Claude Smoke Rerun Result" above.**

Observed blocker on 2026-05-06:

- Claude returned API status `429`.
- Message: `You've hit your limit`.
- Reset time reported by Claude: 2026-05-08 17:00 Asia/Tokyo.
- Before the rate-limit response, Caveat `UserPromptSubmit` hook exited `0`,
  and the Caveat MCP server was connected.

Do not redo the Codex release or codex-sidecar release unless new code changes
land. The next session should only rerun the Claude smoke and record the result.

## Rerun Command

Use a temporary home so the user's real Claude/Codex settings are not modified.

```bash
VERSION=0.14.7
root=$(mktemp -d)
prefix="$root/npm"
home="$root/home"
mkdir -p "$prefix" "$home"
export HOME="$home"
export PATH="$prefix/bin:$PATH"

rtk proxy npm install -g "caveat-cli@$VERSION" --prefix "$prefix" --no-audit --no-fund
rtk caveat init

out="$root/claude-stream.jsonl"
cd /tmp
rtk proxy claude -p \
  --verbose \
  --output-format=stream-json \
  --include-hook-events \
  --setting-sources project \
  --settings "$home/.claude/settings.json" \
  --mcp-config "$home/.claude.json" \
  --strict-mcp-config \
  --model haiku \
  --max-budget-usd 0.05 \
  --permission-mode dontAsk \
  --no-session-persistence \
  "Reply exactly: caveat-claude-session-ok" >"$out"

rtk rg 'caveat-claude-session-ok' "$out"
if rtk rg -i "caveat.*(error|invalid|failed)|invalid.*caveat" "$out"; then
  exit 1
fi
```

Expected:

- Claude exits `0`.
- The stream contains `caveat-claude-session-ok`.
- Caveat `UserPromptSubmit` and `Stop` hook events have `exit_code: 0` and
  `outcome: "success"`.
- MCP server `caveat` is connected.
- No Caveat invalid/failure lines are present.

## Useful Closeout Checks

```bash
rtk npm view caveat-cli version
rtk npm dist-tag ls caveat-cli
rtk npm dist-tag ls codex-sidecar-cli
rtk gh run list --limit 5
rtk git status --short --branch
```

Expected:

- `caveat-cli` latest is `0.14.7`.
- `codex-sidecar-cli` latest is `0.3.0`.
- Latest Caveat CI is green.
- Caveat worktree is clean.
