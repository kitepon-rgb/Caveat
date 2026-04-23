# Caveat

[![npm](https://img.shields.io/npm/v/caveat-cli?color=cb3837&label=caveat-cli)](https://www.npmjs.com/package/caveat-cli)
[![CI](https://github.com/kitepon-rgb/Caveat/actions/workflows/ci.yml/badge.svg)](https://github.com/kitepon-rgb/Caveat/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/caveat-cli?color=blue)](LICENSE)
[![node](https://img.shields.io/node/v/caveat-cli?color=339933&logo=node.js&logoColor=white)](https://nodejs.org/)

External spec gotcha knowledge base. Accumulate the "traps" of GPU drivers, IDE quirks, Claude Code hook availability, tool version constraints, AND your own repo-specific non-obvious context (v0.11) so you don't rediscover them.

**Status**: v0.11.0. **Personal / group knowledge tool — no central shared DB.** Each user writes to their own `~/.caveat/own/`. To share with teammates, push to a group git repo (private or public) and have others subscribe with `caveat community add <repo-url>`. 203 tests passing.

> **v0.11 scope expansion**: Caveat now stores two tiers. **Public** entries are external-spec gotchas that any third party can reproduce. **Private** entries are your own cross-project notes (repo-specific behavior, intentional non-standard design, context that only exists in your workflow). Classification is automatic via a binary criterion on `caveat_record` — explicit user instruction ("record this as private") always wins. Hook-triggered retrieval searches both tiers uniformly; body vocabulary naturally separates them. `caveat stale` surfaces entries not hit by retrieval for 90+ days so you can rewrite or delete buried private notes. See [docs/private-tier-design.md](docs/private-tier-design.md) for the full rationale.

> **v0.7 pivot**: previous versions ran a central shared community DB with `caveat push` (fork + PR) and an auto-subscribe on `caveat init`. That model was retired because trust over arbitrary stranger contributions cannot be reliably automated — sophisticated malicious payloads survive static gates and adversarial-gradient attacks against any LLM-based oracle. Trust is now defined socially (you, your team, your org). See [docs/plan.md](docs/plan.md) for the full rationale and [docs/archive/auto-merge-design.md](docs/archive/auto-merge-design.md) for the abandoned auto-merge design.

## Concept

- **`markdown-in-git` is the source of truth.** SQLite (FTS5 trigram) is a rebuildable derived index, gitignored.
- **Per-group sharing via plain git.** Your `~/.caveat/own/` is yours. Share via any git repo (your own, a team's `acme-corp/caveats`, etc.). Subscribers add it with `caveat community add <github-url>`; updates flow via `caveat community pull`. The tool stays out of the publish path.
- **`visibility: public | private`** frontmatter + `.husky/pre-commit` gate keeps private entries out of any repo you commit to.
- **Claude Code integration.** An MCP server exposes 6 tools (`caveat_search` / `caveat_get` / `caveat_record` / `caveat_update` / `caveat_list_recent` / `caveat_pull`). Three hooks fire at complementary points and surface matching caveats automatically — no hardcoded keyword lists:
  - **UserPromptSubmit** (事前発火): when you submit a prompt, tokenize it, FTS the DB, and surface any entry that shares ≥ 2 distinct tokens (structural co-occurrence rule).
  - **PostToolUse** (実行中発火): when a tool returns `is_error: true`, spawn a detached worker that does the FTS asynchronously so the foreground hook returns in ~20ms; the reminder lands on the next hook tick. Zero added latency in the happy path.
  - **Stop** (事後発火): parse the session transcript for objective struggle signals (tool failures, repeated file edits, web searches, bash retries). If any are present, surface matching entries and nudge `caveat_update` or `caveat_record`.
- **Obsidian-compatible.** The knowledge repo is a valid Obsidian vault — open it as a folder, edit with Obsidian's graph/backlinks/Dataview, the tool re-indexes on `caveat index`.

## Layout

```
packages/core/        @caveat/core — DB (node:sqlite + FTS5 trigram), indexer, frontmatter,
                      env fingerprint, repository, record/update, community, paths,
                      Claude Code hook logic (claudeHooks.ts)
apps/cli/             caveat-cli (published to npm) — bundled CLI with subcommands:
                        init / uninstall / index [--full] / search / list / stale / show /
                        stats / serve / mcp-server / hook <name> / community add|pull|list
apps/mcp/             @caveat/mcp — stdio MCP server exposing 6 tools via
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
caveat init                                                # one-time setup (see below)
caveat search "rtx"                                        # search your local entries
caveat community add https://github.com/acme-corp/caveats  # subscribe to a group repo
caveat pull                                                # git-pull subscribed repos and re-index
caveat serve                                               # http://localhost:4242/ read-only portal
```

What `caveat init` does on first run:
- Writes `~/.caveatrc.json` (empty `{}` — defaults come from a constant in the CLI)
- Scaffolds `~/.caveat/own/` (your knowledge repo root) + `~/.caveat/index/caveat.db`
- Runs `claude mcp add --scope user caveat -- <node> --disable-warning=ExperimentalWarning <cliPath> mcp-server`
- Merges `UserPromptSubmit` / `PostToolUse` / `Stop` hook entries into `~/.claude/settings.json` (existing entries preserved; backup written before any change)

Use `--skip-claude` to skip Claude Code wiring, or `--dry-run` to preview. `caveat uninstall` reverses Claude Code changes without touching `~/.caveat/`. **No central DB is auto-subscribed** — add knowledge sources explicitly with `caveat community add`.

### Sharing with a group / team / company

Caveat does not ship a publish flow. The recommended pattern is plain git:

1. One person creates a GitHub repo (private or public), e.g. `acme-corp/caveats`, with an `entries/` directory.
2. Each contributor either (a) makes that repo their `~/.caveat/own/` (set `knowledgeRepo` in `~/.caveatrc.json`) and writes directly into it, or (b) keeps a separate `~/.caveat/own/` and copies/cherry-picks shareable entries into the team repo by hand.
3. Anyone who wants to read those caveats: `caveat community add https://github.com/acme-corp/caveats` then `caveat pull`.

Because contributors have write access to their own group repo, this is just `git push`; the tool stays out of the path.

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

## Subscribing to other people's / team caveat repos

```sh
caveat community add https://github.com/alice/caveats-alice
caveat community pull         # refresh all subscribed repos
caveat community list
caveat community remove <handle>   # unsubscribe + purge db rows
caveat index                  # re-index to pick up new entries (or use `caveat pull` for the combined flow)

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
corepack pnpm -r test            # 203 tests across 5 packages
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
