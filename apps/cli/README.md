# caveat-cli

External spec gotcha knowledge base CLI — markdown + SQLite FTS5 + MCP server + Claude Code hooks, with a shared community knowledge DB out of the box.

**Source / full docs**: https://github.com/kitepon-rgb/Caveat

## Install

```sh
npm install -g caveat-cli
caveat init
```

`caveat init` (idempotent, `--dry-run` supported) does 4 things:

1. Scaffolds `~/.caveat/own/` (your personal knowledge repo) + `~/.caveat/index/caveat.db`
2. **Subscribes you to the shared community DB** (`kitepon-rgb/Caveat` by default) — shallow-clones into `~/.caveat/community/Caveat/` and indexes so other users' caveats are immediately searchable
3. Registers the MCP server with Claude Code (`claude mcp add --scope user`)
4. Merges `UserPromptSubmit` / `Stop` hooks into `~/.claude/settings.json` (existing entries preserved, backup written before any change)

Opt-out flags: `--skip-claude`, `--skip-shared`. `caveat uninstall` reverses the Claude Code changes without touching `~/.caveat/`.

## Basic usage

```sh
caveat search "rtx"         # FTS across your own entries + the shared community DB
caveat list                 # recent entries
caveat pull                 # fetch new community contributions + re-index
caveat push <entry-id>      # contribute your entry via fork + PR (requires gh CLI)
caveat serve                # http://localhost:4242 read-only portal
caveat community add <url>  # subscribe to an additional community repo
caveat uninstall            # reverse `caveat init` Claude integration
```

## MCP tools (7)

Exposed to Claude Code via the MCP server that `caveat init` registers:

`caveat_search`, `caveat_get`, `caveat_record`, `caveat_update`, `caveat_list_recent`, `caveat_pull`, `caveat_push`.

Claude can autonomously pull community updates (safe, idempotent) and push your recorded caveats (gated by Claude Code's tool permission prompt for user consent — contribution is a public action).

## Pointing at a different shared DB

For an internal/enterprise shared knowledge pool, override in `~/.caveatrc.json`:

```json
{ "sharedRepo": "https://github.com/your-org/your-caveats" }
```

## Requirements

- Node 22.5+ (for built-in `node:sqlite`)
- `gh` CLI authenticated (`gh auth login`) if you want to use `caveat push`
- Claude Code installed if you want MCP / hooks integration. Without it, `caveat init --skip-claude` still provisions local state + shared DB

## License

MIT
