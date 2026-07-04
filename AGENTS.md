# Agent Instructions

`CLAUDE.md` is the source of truth for this repository's behavior, architecture,
and Claude Code integration details. Codex-facing notes in this file are
additive and must not rewrite, rename, or "translate" Claude-specific contracts
into Codex-shaped ones.

When working on dual-agent support:

- Treat Claude commands, hooks, MCP registration, markdown entry format, and
  transcript assumptions documented in `CLAUDE.md` as canonical.
- Add Codex support through adapters, policy helpers, fixtures, and separate
  documentation.
- Do not change Claude-facing field names or hook output text for Codex
  convenience.
- If a Claude-specific section needs clarification, update a separate dual-agent
  note first and only edit `CLAUDE.md` when the Claude contract itself changes.
- Prefer `docs/03_dual_agent_support.md` for Codex sidecar policy and execution
  notes.

