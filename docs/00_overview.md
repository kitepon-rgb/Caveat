# Caveat Documentation Overview

This is the map for the repository's canonical docs. Start here, then follow the
specific document for the task.

## Primary Entrypoints

- [../README.md](../README.md) - human-facing product overview, install, usage, and repository layout.
- [../CLAUDE.md](../CLAUDE.md) - AI-facing operational guide, architecture notes, and verification commands.
- [01_plan.md](01_plan.md) - design source of truth for Caveat's storage, retrieval, sharing, and integration model.
- [02_audit.md](02_audit.md) - audit history and rejected proposals that should not be reopened casually.

## Active Reference Docs

- [03_dual_agent_support.md](03_dual_agent_support.md) - Claude/Codex contract, adapter policy, sidecar behavior, and smoke notes.
- [04_release_checklist.md](04_release_checklist.md) - required publish and post-publish verification checklist.
- [05_next_session.md](05_next_session.md) - current handoff and release closeout notes.
- [adr/](adr/) - architecture decision records. Start with [ADR 0001](adr/0001-markdown-in-git-source-of-truth.md).

## Supporting And Historical Docs

- [private-tier-design.md](private-tier-design.md) and [private-tier-implementation.md](private-tier-implementation.md) - private tier design and implementation planning history.
- [CODEX_HOOK_SUPPORT_PLAN.md](CODEX_HOOK_SUPPORT_PLAN.md) and [CAVEAT_CODEX_DUAL_SUPPORT.md](CAVEAT_CODEX_DUAL_SUPPORT.md) - Codex support planning records; current contract lives in [03_dual_agent_support.md](03_dual_agent_support.md).
- [announcements-v0.12.0.md](announcements-v0.12.0.md) - release announcement drafts.
- [archive/](archive/) - superseded drafts and historical design notes.
- [archive/11_precision_and_runtime_reliability.md](archive/11_precision_and_runtime_reliability.md) - completed 0.16.2 implementation, adversarial audit, Windows timing, and release ledger; BugHub integration was explicitly excluded.

## Repository Areas

- `packages/core/` - markdown parsing, DB schema, FTS indexing, record/update, community, and shared hook retrieval logic.
- `apps/cli/` - published `caveat-cli` command.
- `apps/mcp/` - stdio MCP server imported by the CLI.
- `apps/web/` - read-only Hono web portal.
- `entries/` - public dogfood caveat entries in markdown.
- `hooks/` - pre-commit visibility gate wrapper and tests.
- `rag/` - research asset ledger. Current primary-source and compiled notes are indexed in [`../rag/INDEX.md`](../rag/INDEX.md).
