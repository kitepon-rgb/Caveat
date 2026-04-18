# Caveat

External spec gotcha knowledge base. Accumulate the "traps" of GPU drivers, IDE quirks, Claude Code hook availability, and tool version constraints so you don't rediscover them.

**Status**: Pre-alpha. Phase 9 of 11 complete (tool, CLI, MCP server, Web UI, Claude Code hooks, pre-commit gate, community import, knowledge repo scaffold). Full design in [docs/plan.md](docs/plan.md).

## Concept

- `markdown-in-git` is the source of truth. SQLite (FTS5) is a rebuildable derived index.
- Tool repo (`Caveat`, this repo) and knowledge repo (e.g. `caveats-quo`) are separated so anyone can fork the tool and point it at their own knowledge repo, plus import others'.
- `visibility: public | private` frontmatter; pre-commit hook blocks private entries from being committed to a public repo.
- MCP server + Claude Code hooks let Claude auto-search before work and auto-record new gotchas at session end.

## Structure

```
packages/core/      @caveat/core — DB, indexer, frontmatter, env, repository, types
apps/cli/           (Phase 3) CLI entry
apps/mcp/           (Phase 4) MCP stdio server
apps/web/           (Phase 5) Hono SSR UI
hooks/              (Phase 6) Claude Code user-prompt-submit / stop hooks
.husky/             (Phase 7) pre-commit visibility gate
docs/plan.md        Full design
```

## Development

Requires Node 22.5+ (uses `node:sqlite`). Phase 2 verified on Node 24.14.

```sh
corepack pnpm install
corepack pnpm --filter @caveat/core test
corepack pnpm --filter @caveat/core build
```

## License

MIT
