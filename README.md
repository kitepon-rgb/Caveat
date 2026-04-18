# Caveat

External spec gotcha knowledge base. Accumulate the "traps" of GPU drivers, IDE quirks, Claude Code hook availability, and tool version constraints so you don't rediscover them.

**Status**: v0 feature-complete. All 11 phases done. 135 tests passing across 5 packages (core 84, hooks 24, mcp 10, web 13, cli 4). See [docs/plan.md](docs/plan.md) for the full design.

## Concept

- **`markdown-in-git` is the source of truth.** SQLite (FTS5 trigram) is a rebuildable derived index, gitignored.
- **Tool repo / knowledge repo split.** This repo is the tool. Your caveats live in a separate repo (e.g. `caveats-<you>`) pointed at via `config/default.json` + `~/.caveatrc.json`. You can `caveat community add <github-url>` to import someone else's caveats.
- **`visibility: public | private`** frontmatter + `.husky/pre-commit` gate keeps private entries out of public knowledge repos.
- **Claude Code integration.** An MCP server exposes 7 tools (`caveat_search` / `caveat_get` / `caveat_record` / `caveat_update` / `caveat_list_recent` / `nlm_brief_for` / `ingest_research`). Two hooks (`UserPromptSubmit` keyword-triggered, `Stop` unconditional) remind Claude to search before work and record after.
- **Obsidian-compatible.** The knowledge repo is a valid Obsidian vault — open it as a folder, edit with Obsidian's graph/backlinks/Dataview, the tool re-indexes on `caveat index`.

## Layout

```
packages/core/        @caveat/core — DB (node:sqlite + FTS5 trigram), indexer, frontmatter,
                      env fingerprint, repository, record/update, brief, community, paths
apps/cli/             commander-based CLI:
                        init / index [--full] / search / list / show / stats / serve /
                        community add|pull|list
apps/mcp/             stdio MCP server exposing 7 tools via @modelcontextprotocol/sdk
apps/web/             Hono SSR read-only share portal (/, /g/:id, /community) + custom
                      markdown-it wikilinks plugin for [[slug]] → /g/slug rendering
hooks/                Claude Code hooks (user-prompt-submit.mjs, stop.mjs) + pre-commit
                      visibility gate (pre-commit-visibility-gate.mjs)
.husky/               git pre-commit wiring (husky 9)
config/default.json   knowledgeRepo path, semverKeys, projectRoots (all overridable via
                      ~/.caveatrc.json)
docs/plan.md          Design source of truth (audited through Round 5, then extended
                      Phase 2 → 10 with implementation findings)
docs/audit.md         Audit history (rejected proposals preserved so they don't
                      reappear)
docs/archive/         Superseded drafts (legacy brainstorms, etc.)
```

## Requirements

- **Node 22.5+** (for `node:sqlite`). Verified on Node 24.14 with bundled SQLite 3.51.2.
- **pnpm 10** via corepack (pinned in root `package.json`'s `packageManager`).
- **git** for community import (`simple-git` shells out to the system git).

## Quick start

```sh
corepack pnpm install
corepack pnpm -r build

node apps/cli/dist/index.js init                # creates ~/.caveatrc.json + .index/caveat.db
node apps/cli/dist/index.js index               # scan knowledge repo into SQLite
node apps/cli/dist/index.js search "rtx"        # FTS search
node apps/cli/dist/index.js serve               # http://localhost:4242/ read-only portal
```

## Full setup

### 1. Create your knowledge repo

The tool is useless without a knowledge repo to point at. Create one as a sibling directory:

```sh
mkdir ../caveats-<you>
cd ../caveats-<you>
mkdir entries .templates

# Optional but recommended: copy the template + gitignore from caveats-quo (see
# a working example at https://github.com/kitepon-rgb/caveats-quo — private but
# the layout is documented). Minimum:

cat > .gitignore <<'EOF'
*.private.md
.obsidian/
EOF

cat > .templates/caveat.md <<'EOF'
---
id: <slug>
title: <one-line title>
visibility: public
confidence: tentative
outcome: resolved
tags: []
environment: {}
source_project: null
source_session: "manual/{{date:YYYY-MM-DD}}"
created_at: {{date:YYYY-MM-DD}}
updated_at: {{date:YYYY-MM-DD}}
last_verified: {{date:YYYY-MM-DD}}
---

## Context
## Symptom
## Cause
## Resolution
## Evidence
EOF

git init -b main
git add .
git commit -m "init: scaffold"
# Create a matching GitHub repo (private initially recommended):
# gh repo create caveats-<you> --private --source=. --push
```

### 2. Point the tool at your knowledge repo

Edit `~/.caveatrc.json` in the tool-repo's parent (auto-created by `caveat init`):

```json
{
  "knowledgeRepo": "/absolute/path/to/caveats-<you>",
  "projectRoots": ["c:/users/<you>/documents/program/"]
}
```

`projectRoots` tells `caveat_record` how to infer `source_project` from your cwd. Put your workspace root(s). Empty array disables auto-detection.

### 3. Wire into Claude Code

**MCP server registration** (writes to `~/.claude.json`):

```sh
claude mcp add --scope user caveat node \
  -- --disable-warning=ExperimentalWarning \
     "/absolute/path/to/Caveat/apps/mcp/dist/server.js"

claude mcp list   # expect: caveat: ... ✓ Connected
```

`--disable-warning=ExperimentalWarning` is required: MCP uses stdout for JSON-RPC, so the one-time `node:sqlite` `ExperimentalWarning` must be suppressed. Without this flag the server still works, but emits one extra stderr line per session.

**Hooks** (append to `~/.claude/settings.json`; these run alongside any existing hooks):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command",
          "command": "node /absolute/path/to/Caveat/hooks/user-prompt-submit.mjs" } ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command",
          "command": "node /absolute/path/to/Caveat/hooks/stop.mjs" } ] }
    ]
  }
}
```

The `UserPromptSubmit` hook fires a reminder to call `caveat_search` only when the prompt mentions GPU/driver/CUDA/IDE/version/flakiness keywords — silent otherwise. The `Stop` hook unconditionally reminds Claude to consider `caveat_record` (including `outcome: impossible` conclusions).

### 4. (Optional) Pre-commit gate on your knowledge repo

The tool repo already has `.husky/pre-commit` wired. To enable the same gate on your knowledge repo so private entries can't leak:

```sh
cd /path/to/caveats-<you>
npm init -y   # or pnpm init
npm install --save-dev husky
npx husky init

# Copy the gate script:
cp /path/to/Caveat/hooks/pre-commit-visibility-gate.mjs hooks/
# Edit .husky/pre-commit to exec that script (one line: `exec node "$(dirname "$0")/../hooks/pre-commit-visibility-gate.mjs"`)
```

The gate rejects any commit that stages an `entries/**/*.md` with `visibility: private`. Bypass only with `git commit --no-verify` (git standard), not a custom flag.

### 5. (Optional) Open knowledge repo in Obsidian

`caveats-<you>/` is a valid Obsidian vault. `File → Open folder as vault`. Recommended plugins:

| Plugin | Purpose |
|---|---|
| **Templates** (core) | Settings > Templates → folder `.templates/`. Then `Insert template` inserts the frontmatter skeleton. |
| **Obsidian Git** | Sync your vault to GitHub from inside Obsidian. |
| **Dataview** | Frontmatter queries. E.g. `TABLE confidence, environment.gpu FROM "entries" WHERE outcome = "impossible"`. |

Caveats authored in Obsidian are picked up by `caveat index` on next run (FTS is eventually consistent; MCP `caveat_record` syncs immediately).

## Import other people's caveats

```sh
node apps/cli/dist/index.js community add https://github.com/alice/caveats-alice
node apps/cli/dist/index.js community pull       # refresh all imported repos
node apps/cli/dist/index.js community list
node apps/cli/dist/index.js index                # re-index to pick up new entries

# Then search only their contributions:
node apps/cli/dist/index.js search "foo" --source community
```

URL validation is strict — only `^https://github.com/<org>/<repo>(\.git)?/?$` is accepted. GitLab / SSH / HTTP are rejected in v1.

## Knowledge repo format

Each caveat is a markdown file with YAML frontmatter. Example:

```markdown
---
id: rtx-5090-cuda-12-compat
title: RTX 5090 で CUDA 12.4 以前が初期化失敗する
visibility: public
confidence: reproduced          # confirmed | reproduced | tentative
outcome: resolved               # resolved | impossible
tags: [gpu, nvidia, cuda]
environment:
  gpu: RTX 5090
  cuda: ">=12.5"
source_project: llm-infer-bench
source_session: "2026-04-18T12:34:56Z/abcdef012345"
created_at: 2026-04-18
updated_at: 2026-04-18
last_verified: 2026-04-18
---

## Symptom
## Cause
## Resolution
## Evidence
```

See [docs/plan.md](docs/plan.md) for the full schema, semver matching rules, and MCP tool specs.

## Development

```sh
corepack pnpm -r test            # 135 tests across 5 packages
corepack pnpm -r typecheck
corepack pnpm -r build
```

Per-package:
```sh
corepack pnpm --filter @caveat/core test
corepack pnpm --filter @caveat/cli test
corepack pnpm --filter @caveat/mcp test
corepack pnpm --filter @caveat/web test
corepack pnpm --filter @caveat/hooks test
```

Contributing: see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
