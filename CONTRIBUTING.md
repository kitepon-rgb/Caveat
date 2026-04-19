# Contributing to Caveat

Thanks for considering a contribution. This repo is **both** the tool (`packages/`, `apps/`) **and** the shared knowledge DB (`entries/`) — two distinct contribution tracks. See the "Track" sections below for which applies.

## Track A — contributing a caveat to the shared knowledge DB (the common case)

Use the tool itself. After `npm i -g caveat-cli && caveat init`, write your caveat in `~/.caveat/own/entries/<category>/<slug>.md` (or via `mcp__caveat__caveat_record` in Claude Code), then:

```sh
caveat push <entry-id>
```

This forks this repo under your GitHub account (once), commits the entry on a branch, pushes, and opens a PR. Requires `gh` CLI authenticated (`gh auth login`). Maintainer merges PRs that pass the visibility gate and aren't duplicates.

You can also open a PR manually if you prefer — drop your md file in the correct `entries/<category>/` directory on a branch of your fork. The format is documented in the root README.

## Track B — contributing to the tool itself

This doc is short on purpose — Caveat is a small, opinionated tool, so the bar for changes is "does it match the design in `docs/plan.md`, and is it verified by tests?"

## Before you start

Read [docs/plan.md](docs/plan.md). It is the **source of truth for design decisions**. The plan has been through 5 audit rounds plus Phase 2–10 implementation findings. If your idea conflicts with the plan, open an issue first with the rationale rather than a PR — the plan may need updating.

Read [docs/audit.md](docs/audit.md). It lists proposals that were explicitly rejected during the design rounds. Please don't re-open those.

## Local setup

Requires Node 22.5+ and pnpm 10 (via corepack). Windows, macOS, and Linux are all supported — the only OS-specific path is `node:sqlite` (Node bundles its own SQLite so you don't need system SQLite installed).

```sh
corepack pnpm install
corepack pnpm -r build
corepack pnpm -r test        # expect 136 tests green
corepack pnpm -r typecheck
```

## What a good PR looks like

- **Small and focused.** One concern per PR. A new CLI flag, a bug fix, a new MCP tool — but not all three at once.
- **Tested.** Unit tests for core logic. Integration / spawn tests for CLI and hooks. If you touch `packages/core`, add or update tests under `packages/core/tests/`.
- **Design-aligned.** If you're adding a feature, point to the section of `docs/plan.md` that justifies it. If the plan doesn't cover it, update the plan in the same PR.
- **No unnecessary fallbacks.** Caveat avoids multi-layer defensive code. If you want a second safeguard for something, show why one layer isn't enough. See [docs/audit.md](docs/audit.md) for examples of rejected layered defenses.
- **Typecheck + tests pass.** `pnpm -r typecheck && pnpm -r test` should be green before opening the PR.

## What a bad PR looks like

- Mechanical framework upgrades with no behavior change (e.g. bumping dep major versions). Open an issue first.
- Adding an abstraction "in case" something changes later. Ship the simplest thing that works; abstract when a second real caller appears.
- Rewriting the plan to match your taste without concrete cause. The plan is audited; breaking changes there need an audit round.
- Re-introducing a pattern that `docs/audit.md` lists as rejected.

## Areas that welcome contribution

- **New MCP tool additions.** The v0.6 7-tool set (`caveat_search`, `_get`, `_record`, `_update`, `_list_recent`, `caveat_pull`, `caveat_push`) is the baseline. Ideas like `caveat_diff` or `caveat_merge` between community sources could be useful — propose via issue with motivation.
- **Community caveat format compatibility.** If you're building a similar tool and want interop, open an issue discussing the shared frontmatter subset.
- **Obsidian plugin bridges.** A plugin that shells out to `caveat search` or `caveat_record` could smooth vault editing. Separate repo, referenced from README.
- **Indexing performance.** `scanSource` does a full re-walk per source. If your knowledge repo has >10k entries and indexing is slow, a git-log-based incremental path would be welcome.

## Areas that won't be merged

These are intentionally out-of-scope for v1:

- **Non-GitHub community sources.** Plan [docs/plan.md](docs/plan.md) pins GitHub-only for v1; GitLab / self-hosted is a deliberate v2 topic. Don't loosen the URL regex in `validateCommunityUrl` without a design change.
- **Custom YAML tags in frontmatter.** `gray-matter` is configured with `JSON_SCHEMA` specifically to reject `!!js/function` etc. Loosening that re-opens CVE class.
- **Stringly-typed frontmatter.** The `Frontmatter` type and zod schemas in MCP tools are the canonical shape. Don't bypass via `Record<string, unknown>`.
- **Auto-push on `caveat community add`.** Community repos are added as local clones only. Push / sync back to origin is out of scope for v1.
- **NotebookLM-specific tooling.** `nlm_brief_for` + `ingest_research` were removed in v0.6 as thin wrappers over `caveat_record`. Claude can generate research prompts in-context and record results with `confidence: tentative` directly. Don't re-add.

## Filing issues

- **Bug reports**: include reproduction (md fixture, commands run, expected vs actual). Link the exact file + line if you can.
- **Feature requests**: explain the real use case, link the plan.md section it extends (or explain why the plan needs to change).
- **Security**: if you find a way for a `visibility: private` entry to escape the pre-commit gate, or a way for `caveat_update` to mutate an immutable key, please open a private security advisory on GitHub rather than a public issue.

## Commit messages

`<type>: <imperative summary>` format. Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`. Body optional but encouraged for non-trivial changes — explain the *why*, not the *what* (the diff already shows the what).

## License

By submitting a PR you agree to license your contribution under MIT.
