# 0001. Keep Markdown In Git As The Source Of Truth

Date: 2026-07-04

## Status

Accepted. This records an existing repository decision; it does not introduce a
new behavior change.

## Context

`CLAUDE.md`, `README.md`, and `docs/01_plan.md` all describe Caveat's knowledge
model as markdown-in-git. Caveat stores entries as markdown files and uses
SQLite FTS5 as a rebuildable local index under Caveat home. The project also
retired the central shared community DB model in favor of personal and group git
repositories selected by the user.

## Decision

The canonical knowledge store remains markdown files managed by git. SQLite is a
derived index and must be rebuildable from markdown. Git remotes remain the
transport, while `caveat sync` enforces the private ownership boundary and
`caveat publish` emits the public sealed mirror. Caveat does not define a
central trust server.

## Consequences

- Entry format, frontmatter, and markdown parsing are compatibility-critical.
- DB schema and indexing code must not become the only place where knowledge
state exists.
- The user chooses trusted publishers; Caveat owns and enforces the declared
  private/public transport boundary without becoming a central trust authority.
- Obsidian and similar tools may act as windows over the markdown, but they are
not the source of truth.
