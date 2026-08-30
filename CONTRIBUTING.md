# Contributing to Caveat

Thanks for considering a contribution. This document covers contributions **to the tool itself** (`packages/`, `apps/`).

> **Sharing note**: Caveat owns the current sharing boundary. Use `caveat sync` for an authenticated private remote and `caveat publish` for the public sealed mirror. See [README.md](README.md#sharing-two-boundaries-two-commands) for the current contract, and [docs/archive/auto-merge-design.md](docs/archive/auto-merge-design.md) for why the old central auto-merge approach was abandoned.

This doc is short on purpose — Caveat is a small, opinionated tool, so the bar for changes is "does it match the design in `docs/01_plan.md`, and is it verified by tests?"

## Before you start

Read [docs/01_plan.md](docs/01_plan.md). It is the current product, state,
sharing, host, and ownership contract. If your idea conflicts with it, update the
contract in the same change or open an issue explaining the intended change.

Past audit rounds and rejected proposals are retained in
[docs/archive/02_audit.md](docs/archive/02_audit.md). Read that history only
when a proposal overlaps an earlier decision.

## Local setup

Requires Node 22.5+ and pnpm 10 (via corepack). Windows, macOS, and Linux are all supported — the only OS-specific path is `node:sqlite` (Node bundles its own SQLite so you don't need system SQLite installed).

```sh
corepack pnpm install
corepack pnpm -r build
corepack pnpm -r test
corepack pnpm -r typecheck
```

## What a good PR looks like

- **Small and focused.** One concern per PR. A new CLI flag, a bug fix, a new MCP tool — but not all three at once.
- **Tested.** Unit tests for core logic. Integration / spawn tests for CLI and hooks. If you touch `packages/core`, add or update tests under `packages/core/tests/`.
- **Design-aligned.** If you're adding a feature, point to the section of `docs/01_plan.md` that justifies it. If the plan doesn't cover it, update the plan in the same PR.
- **No unnecessary fallbacks.** Caveat avoids multi-layer defensive code. If you want a second safeguard for something, show why one layer isn't enough. The historical audit records examples of rejected layered defenses.
- **Typecheck + tests pass.** `pnpm -r typecheck && pnpm -r test` should be green before opening the PR.

## What a bad PR looks like

- Mechanical framework upgrades with no behavior change (e.g. bumping dep major versions). Open an issue first.
- Adding an abstraction "in case" something changes later. Ship the simplest thing that works; abstract when a second real caller appears.
- Rewriting the plan to match your taste without concrete cause. The plan is audited; breaking changes there need an audit round.
- Re-introducing a pattern that the archived audit explicitly rejected without new evidence.

## Areas that welcome contribution

- **New MCP tool additions.** The v0.7 6-tool set (`caveat_search`, `_get`, `_record`, `_update`, `_list_recent`, `caveat_pull`) is the baseline. Ideas like `caveat_diff` or `caveat_merge` between community sources could be useful — propose via issue with motivation.
- **Community caveat format compatibility.** If you're building a similar tool and want interop, open an issue discussing the shared frontmatter subset.
- **Obsidian plugin bridges.** A plugin that shells out to `caveat search` or `caveat_record` could smooth vault editing. Separate repo, referenced from README.
- **Indexing performance.** `scanSource` does a full re-walk per source. If your knowledge repo has >10k entries and indexing is slow, a git-log-based incremental path would be welcome.

## Areas that won't be merged

These are intentionally out-of-scope for v1:

- **Non-GitHub community sources.** The current `validateCommunityUrl` contract accepts GitHub sources only. Do not loosen it without updating the product contract and its security tests.
- **Custom YAML tags in frontmatter.** `gray-matter` is configured with `JSON_SCHEMA` specifically to reject `!!js/function` etc. Loosening that re-opens CVE class.
- **Stringly-typed frontmatter.** The `Frontmatter` type and zod schemas in MCP tools are the canonical shape. Don't bypass via `Record<string, unknown>`.
- **Auto-push on `caveat community add`.** Community repos are added as local clones only. Push / sync back to origin is out of scope for v1.
- **NotebookLM-specific tooling.** `nlm_brief_for` + `ingest_research` were removed in v0.6 as thin wrappers over `caveat_record`. Claude can generate research prompts in-context and record results with `confidence: tentative` directly. Don't re-add.

## Filing issues

- **Bug reports**: include reproduction (md fixture, commands run, expected vs actual). Link the exact file + line if you can.
- **Feature requests**: explain the real use case, link the 01_plan.md section it extends (or explain why the plan needs to change).
- **Security**: if `sync` can cross the private remote boundary, `publish` can leak private/plaintext content, or `caveat_update` can mutate an immutable key, open a private security advisory rather than a public issue.

## Commit messages

`<type>: <imperative summary>` format. Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`. Body optional but encouraged for non-trivial changes — explain the *why*, not the *what* (the diff already shows the what).

## License

By submitting a PR you agree to license your contribution under MIT.
