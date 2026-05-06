# Release Checklist

Use this checklist for every `caveat-cli` npm release. Do not stop at publish:
the release is only complete after the published package passes fresh-install
and new-session Claude/Codex smoke checks.

## Pre-Publish

Run workspace checks sequentially. Do not run `build` and `typecheck` in
parallel: `build` may clean package `dist/` output while downstream packages are
resolving generated declarations.

```bash
rtk proxy corepack pnpm -r build
rtk proxy corepack pnpm -r typecheck
rtk proxy corepack pnpm -r test
rtk git diff --check
```

Update the version and release notes, then verify the packed manifest before
publishing. Publish from `apps/cli` with pnpm; direct `npm publish` is forbidden
because it can leave `workspace:*` strings in the packed manifest.

```bash
cd apps/cli
tmpdir=$(mktemp -d)
rtk proxy corepack pnpm pack --pack-destination "$tmpdir" --json
rtk proxy corepack pnpm publish --dry-run --no-git-checks
```

Commit, tag, push, wait for CI, then publish:

```bash
rtk git status --short --branch
rtk git push
rtk git push origin "v$VERSION"
rtk proxy corepack pnpm publish --no-git-checks
```

## Published Package Smoke

Install from npm into a temporary prefix, not from the local workspace.

```bash
root=$(mktemp -d)
prefix="$root/npm"
mkdir -p "$prefix"
rtk proxy npm install -g "caveat-cli@$VERSION" --prefix "$prefix"
rtk "$prefix/bin/caveat" --version
rtk stat -c '%a %n' "$prefix/lib/node_modules/caveat-cli/dist/caveat.js"
rtk node -e 'const p=require(process.argv[1]); console.log(JSON.stringify({version:p.version,bin:p.bin,commander:p.dependencies.commander}, null, 2))' \
  "$prefix/lib/node_modules/caveat-cli/package.json"
```

Expected:

- `caveat --version` prints `$VERSION`.
- `dist/caveat.js` is executable (`755` on Linux).
- The manifest has `bin.caveat = "dist/caveat.js"`.

## Fresh Install Hook Smoke

Use a temporary `HOME` so the user's real Claude/Codex config is not modified.

```bash
root=$(mktemp -d)
prefix="$root/npm"
home="$root/home"
mkdir -p "$prefix" "$home"
export HOME="$home"
export PATH="$prefix/bin:$PATH"
export CODEX_HOME="$home/.codex"

rtk proxy npm install -g "caveat-cli@$VERSION" --prefix "$prefix"
rtk caveat init
rtk caveat codex-hook install --codex-home "$CODEX_HOME"
rtk caveat codex-hook diagnostics --codex-home "$CODEX_HOME"
```

Verify generated config:

- `~/.claude/settings.json` contains Caveat `UserPromptSubmit`,
  `PostToolUse`, `PostToolUseFailure`, and `Stop` commands.
- `~/.claude.json` contains the `caveat` MCP registration.
- `~/.codex/hooks.json` contains Caveat `UserPromptSubmit`, `PostToolUse`, and
  `Stop` commands with `timeoutSec: 5` and `async: false`.
- `~/.codex/config.toml` contains `[features] codex_hooks = true`.

Run install twice and require `unchanged` on the second run. Run uninstall and
require zero remaining Caveat hook entries.

## New Codex Session Smoke

Use a temporary `CODEX_HOME` created by the fresh-install smoke. Do not copy
auth material into the repository. If auth is needed, symlink the existing
user-level Codex auth files into the temporary Codex home and remove the whole
temporary directory after the smoke.

```bash
ln -sfn "$REAL_CODEX_HOME/auth.json" "$CODEX_HOME/auth.json"
ln -sfn "$REAL_CODEX_HOME/installation_id" "$CODEX_HOME/installation_id"

out="$root/codex-exec.jsonl"
last="$root/codex-last.txt"
rtk proxy codex exec \
  --json \
  -C /tmp \
  --skip-git-repo-check \
  -s read-only \
  -m gpt-5.4-mini \
  -o "$last" \
  "Reply exactly: caveat-new-session-ok" >"$out"

if rtk rg -i "hook returned invalid|hook.*failed|invalid user prompt" "$out"; then
  exit 1
fi
```

Expected:

- `codex exec` exits 0.
- `$last` contains `caveat-new-session-ok`.
- No hook invalid/failure lines are present.

## Codex Sidecar Advisory Smoke

Run this after the new Codex session smoke, using the same temporary `HOME`,
`PATH`, and authenticated `CODEX_HOME`. This proves the Caveat hook advisory
path reaches `codex-sidecar`, starts Codex App Server with the `advisory`
preset, and records the intended model policy in the raw App Server log.

`codex-sidecar` must be installed on `PATH`, or `CAVEAT_CODEX_SIDECAR_COMMAND`
must point at the command to use.

```bash
repo=$(rtk git rev-parse --show-toplevel)
export CAVEAT_CODEX_SIDECAR_COMMAND="${CAVEAT_CODEX_SIDECAR_COMMAND:-codex-sidecar}"

diag="$root/caveat-sidecar-advisory-diagnostics.json"
rtk caveat codex-sidecar diagnostics \
  --project "$repo" \
  --preset advisory \
  --save-result "$diag"

rtk node -e '
const fs = require("node:fs");
const result = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (result.modelPolicy?.source !== "explicit") throw new Error("modelPolicy.source is not explicit");
if (result.normalizedRequest?.model !== "gpt-5.4-mini") throw new Error("unexpected advisory model");
if (result.normalizedRequest?.modelReasoningEffort !== "low") throw new Error("unexpected advisory effort");
' "$diag"

export CAVEAT_HOME="$root/caveat-home-sidecar"
mkdir -p "$CAVEAT_HOME"

transcript="$root/caveat-sidecar-stop.jsonl"
cat >"$transcript" <<'JSONL'
{"timestamp":"2026-05-06T00:00:00.000Z","type":"assistant","message":{"content":[{"type":"tool_result","is_error":true,"content":"release smoke failure for Caveat Codex sidecar advisory"}]}}
JSONL

CAVEAT_HOOK_CODEX_SIDECAR=require \
CAVEAT_HOOK_CODEX_SIDECAR_TIMEOUT_MS=240000 \
rtk caveat hook stop <<EOF
{"session_id":"sidecar-smoke","transcript_path":"$transcript","hook_event_name":"Stop","stop_hook_active":false}
EOF

pending=$(find "$CAVEAT_HOME/pending/sidecar-smoke" -type f -name '*.txt' | head -1)
rtk test -f "$pending"
rtk rg '\[caveat:codex-sidecar\] Codex advisory:' "$pending"
if rtk rg 'advisory unavailable' "$pending"; then
  exit 1
fi

raw_log=$(sed -n 's/^rawEventLogRef: //p' "$pending" | tail -1)
rtk test -f "$raw_log"
rtk node -e '
const fs = require("node:fs");
let startupOk = false;
let threadOk = false;
for (const line of fs.readFileSync(process.argv[1], "utf8").trim().split(/\n/)) {
  const entry = JSON.parse(line);
  if (entry.event === "process/start") {
    const args = entry.data?.args ?? [];
    startupOk =
      args.includes("model=\"gpt-5.4-mini\"") &&
      args.includes("model_reasoning_effort=\"low\"");
  }
  if (entry.event === "message/receive" && typeof entry.data?.line === "string") {
    threadOk ||= entry.data.line.includes("\"model\":\"gpt-5.4-mini\"") &&
      entry.data.line.includes("\"reasoningEffort\":\"low\"");
  }
}
if (!startupOk) throw new Error("raw log does not contain advisory startup model policy");
if (!threadOk) throw new Error("raw log does not contain advisory thread model policy");
' "$raw_log"
```

Expected:

- Diagnostics report `modelPolicy.source: "explicit"`.
- `normalizedRequest.model` is `gpt-5.4-mini`.
- `normalizedRequest.modelReasoningEffort` is `low`.
- The hook pending reminder contains `[caveat:codex-sidecar] Codex advisory:`.
- The hook pending reminder does not contain `advisory unavailable`.
- The raw App Server log contains startup args for `model="gpt-5.4-mini"` and
  `model_reasoning_effort="low"`.
- The raw App Server `thread/start` response reports `model: "gpt-5.4-mini"`
  and `reasoningEffort: "low"`.

## New Claude Session Smoke

Use Haiku for cost control. Avoid project-local hooks contaminating the result:
run from `/tmp` and pass the fresh-install Caveat settings/MCP files explicitly.

```bash
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

if rtk rg -i "caveat.*(error|invalid|failed)|invalid.*caveat" "$out"; then
  exit 1
fi
```

Expected:

- Claude uses a Haiku model.
- `UserPromptSubmit` and `Stop` hook events both have `exit_code: 0` and
  `outcome: "success"`.
- The result is `caveat-claude-session-ok`.
- No Caveat hook invalid/failure lines are present.

## Closeout

Before reporting the release complete:

```bash
rtk gh run list --limit 5
rtk gh pr list --state open --json number,title,author
rtk npm view caveat-cli version
rtk git status --short --branch
```

Expected:

- Latest `main` CI is green.
- No superseded Dependabot PR remains open.
- npm latest equals `$VERSION`.
- Worktree is clean and synced with `origin/main`.
