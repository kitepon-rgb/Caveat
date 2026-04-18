# Caveat

External spec gotcha knowledge base. Accumulate the "traps" of GPU drivers, IDE quirks, Claude Code hook availability, and tool version constraints so you don't rediscover them.

**Status**: Pre-alpha. Phase 9 of 11 complete. All 5 workspace packages ship with tests (core 84 / hooks 24 / mcp 10 / web 13 / cli 4 = **135 passing**). Remaining phases are settings wiring and README polish. Full design in [docs/plan.md](docs/plan.md).

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
                      Phase 2 → 9 with implementation findings)
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

# Point to your own knowledge repo (or accept the default relative path):
# echo '{"knowledgeRepo": "/absolute/path/to/your/caveats-<you>"}' > ~/.caveatrc.json

node apps/cli/dist/index.js init           # creates ~/.caveatrc.json (if missing) + .index/caveat.db
node apps/cli/dist/index.js index           # scan knowledge repo into SQLite
node apps/cli/dist/index.js search "rtx"    # FTS search
node apps/cli/dist/index.js serve           # http://localhost:4242/ read-only portal
```

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

## License

MIT
