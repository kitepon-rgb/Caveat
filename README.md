# Caveat

[![npm](https://img.shields.io/npm/v/caveat-cli?color=cb3837&label=caveat-cli)](https://www.npmjs.com/package/caveat-cli)
[![CI](https://github.com/kitepon-rgb/Caveat/actions/workflows/ci.yml/badge.svg)](https://github.com/kitepon-rgb/Caveat/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/caveat-cli?color=blue)](LICENSE)
[![node](https://img.shields.io/node/v/caveat-cli?color=339933&logo=node.js&logoColor=white)](https://nodejs.org/)

External spec gotcha knowledge base. Accumulate the "traps" of GPU drivers, IDE quirks, Claude Code hook availability, and tool version constraints so you don't rediscover them.

**Status**: v0.6.1. One repo is **both** the tool source (`packages/`, `apps/`) **and** the shared knowledge DB (`entries/`). `npm i -g caveat-cli && caveat init` auto-subscribes you; `caveat pull` receives others' merged contributions, `caveat push <id>` contributes via fork + PR (requires gh CLI). 136 tests passing.

## Concept

- **`markdown-in-git` is the source of truth.** SQLite (FTS5 trigram) is a rebuildable derived index, gitignored.
- **Unified repo.** The tool source and the shared community knowledge DB live together. Users write to their own entries in `~/.caveat/own/`, then `caveat push <id>` opens a PR to this repo. Subscribers receive merged entries via `caveat pull`. Opt into an additional source with `caveat community add <github-url>`.
- **`visibility: public | private`** frontmatter + `.husky/pre-commit` gate keeps private entries out of public knowledge repos.
- **Claude Code integration.** An MCP server exposes 7 tools (`caveat_search` / `caveat_get` / `caveat_record` / `caveat_update` / `caveat_list_recent` / `caveat_pull` / `caveat_push`). Two hooks (`UserPromptSubmit` keyword-triggered, `Stop` unconditional) remind Claude to search before work and record after.
- **Obsidian-compatible.** The knowledge repo is a valid Obsidian vault — open it as a folder, edit with Obsidian's graph/backlinks/Dataview, the tool re-indexes on `caveat index`.

## Layout

```
packages/core/        @caveat/core — DB (node:sqlite + FTS5 trigram), indexer, frontmatter,
                      env fingerprint, repository, record/update, community, paths,
                      Claude Code hook logic (claudeHooks.ts)
apps/cli/             caveat-cli (published to npm) — bundled CLI with subcommands:
                        init / uninstall / index [--full] / search / list / show / stats /
                        serve / mcp-server / hook <name> / community add|pull|list
apps/mcp/             @caveat/mcp — stdio MCP server exposing 7 tools via
                      @modelcontextprotocol/sdk. Imported by caveat-cli as `mcp-server`
apps/web/             @caveat/web — Hono SSR read-only share portal (/, /g/:id, /community) +
                      custom markdown-it wikilinks plugin for [[slug]] → /g/slug rendering
hooks/                legacy standalone .mjs hooks (dev-mode fallback + spawn tests). NPM
                      users hit `caveat hook <name>` via the CLI instead
.husky/               git pre-commit wiring (husky 9)
docs/plan.md          Design source of truth (audited through Round 5, then extended
                      Phase 2 → 12 with implementation findings)
docs/audit.md         Audit history (rejected proposals preserved so they don't reappear)
docs/archive/         Superseded drafts (legacy brainstorms, etc.)
```

## Requirements

- **Node 22.5+** (for `node:sqlite`). Verified on Node 24.14 with bundled SQLite 3.51.2.
- **pnpm 10** via corepack (pinned in root `package.json`'s `packageManager`).
- **git** for community import (`simple-git` shells out to the system git).

## Quick start (NPM user)

```sh
npm install -g caveat-cli
caveat init                   # full setup (see below)
caveat search "rtx"           # search across your entries + the shared community DB
caveat pull                   # fetch new community contributions and re-index
caveat push <id>              # contribute your entry to the shared DB via PR (requires gh)
caveat serve                  # http://localhost:4242/ read-only share portal
```

What `caveat init` does on first run:
- Writes `~/.caveatrc.json` (empty `{}` — defaults come from a constant in the CLI)
- Scaffolds `~/.caveat/own/` (your knowledge repo root) + `~/.caveat/index/caveat.db`
- **Subscribes to the shared community DB** [kitepon-rgb/Caveat](https://github.com/kitepon-rgb/Caveat): shallow-clones into `~/.caveat/community/Caveat/` and indexes so entries are immediately searchable
- Runs `claude mcp add --scope user caveat -- <node> --disable-warning=ExperimentalWarning <cliPath> mcp-server`
- Merges `UserPromptSubmit` / `Stop` hook entries into `~/.claude/settings.json` (existing entries preserved; backup written before any change)

Use `--skip-claude` to skip Claude Code wiring, `--skip-shared` to opt out of the community DB, or `--dry-run` to preview. `caveat uninstall` reverses Claude Code changes without touching `~/.caveat/`.

### Contributing a caveat

```sh
caveat push <entry-id>        # requires `gh` CLI + `gh auth login`
```

`caveat push` forks the shared repo under your GitHub account (once), creates a branch, commits the entry md, pushes, and opens a PR. Merged PRs propagate to all subscribers on their next `caveat pull`.

To point at a different shared DB (e.g. internal enterprise repo), set `sharedRepo` in `~/.caveatrc.json`:

```json
{ "sharedRepo": "https://github.com/your-org/your-caveats" }
```

### Using an existing knowledge repo instead of `~/.caveat/own/`

Write `~/.caveatrc.json`:

```json
{
  "knowledgeRepo": "/absolute/path/to/your/caveats-repo"
}
```

(v0.2+) `source_project` is always written as `null` by `caveat_record`. It used to be auto-inferred from cwd via a `projectRoots` config field, but that leaked per-user project names into publicly-shared knowledge repos and has been removed. Set it manually in the md file if you want personal traceability on private entries.

## Quick start (dev — contributing to Caveat itself)

```sh
corepack pnpm install
corepack pnpm -r build
cd apps/cli && corepack pnpm pack        # caveat-cli-<ver>.tgz
npm install -g ./caveat-cli-<ver>.tgz    # now `caveat` is on PATH
```

For iterative dev, `npm link` inside `apps/cli/` keeps the global shim tracking your local build.

### (Optional) Pre-commit gate on your knowledge repo

The tool repo already has `.husky/pre-commit` wired. To enable the same gate on your knowledge repo so private entries can't leak:

```sh
cd /path/to/your/caveats-repo
npm init -y   # or pnpm init
npm install --save-dev husky
npx husky init

# Copy the gate script:
cp /path/to/Caveat/hooks/pre-commit-visibility-gate.mjs hooks/
# Edit .husky/pre-commit to exec that script (one line: `exec node "$(dirname "$0")/../hooks/pre-commit-visibility-gate.mjs"`)
```

The gate rejects any commit that stages an `entries/**/*.md` with `visibility: private`. Bypass only with `git commit --no-verify` (git standard), not a custom flag.

### (Optional) Open knowledge repo in Obsidian

Your knowledge repo (default `~/.caveat/own/`) is a valid Obsidian vault. `File → Open folder as vault`. Recommended plugins:

| Plugin | Purpose |
|---|---|
| **Templates** (core) | Settings > Templates → folder `.templates/`. Then `Insert template` inserts the frontmatter skeleton. |
| **Obsidian Git** | Sync your vault to GitHub from inside Obsidian. |
| **Dataview** | Frontmatter queries. E.g. `TABLE confidence, environment.gpu FROM "entries" WHERE outcome = "impossible"`. |

Caveats authored in Obsidian are picked up by `caveat index` on next run (FTS is eventually consistent; MCP `caveat_record` syncs immediately).

## Import other people's caveats

```sh
caveat community add https://github.com/alice/caveats-alice
caveat community pull       # refresh all imported repos
caveat community list
caveat index                # re-index to pick up new entries

# Then search only their contributions:
caveat search "foo" --source community
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
corepack pnpm -r test            # 136 tests across 5 packages
corepack pnpm -r typecheck
corepack pnpm -r build
```

Per-package:
```sh
corepack pnpm --filter @caveat/core test
corepack pnpm --filter caveat-cli test
corepack pnpm --filter @caveat/mcp test
corepack pnpm --filter @caveat/web test
corepack pnpm --filter @caveat/hooks test
```

Contributing: see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
