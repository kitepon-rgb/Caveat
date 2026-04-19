# caveat-cli

External spec gotcha knowledge base CLI — markdown + SQLite FTS5 + MCP server + Claude Code hooks. Personal / group knowledge tool, no central shared DB.

**Source / full docs**: https://github.com/kitepon-rgb/Caveat

## Install

```sh
npm install -g caveat-cli
caveat init
```

`caveat init` (idempotent, `--dry-run` supported) does 3 things:

1. Scaffolds `~/.caveat/own/` (your personal knowledge repo) + `~/.caveat/index/caveat.db`
2. Registers the MCP server with Claude Code (`claude mcp add --scope user`)
3. Merges `UserPromptSubmit` / `Stop` hooks into `~/.claude/settings.json` (existing entries preserved, backup written before any change)

Opt-out: `--skip-claude`. `caveat uninstall` reverses the Claude Code changes without touching `~/.caveat/`. **No central DB is auto-subscribed** — add knowledge sources explicitly with `caveat community add`.

## Basic usage

```sh
caveat search "rtx"                 # FTS across your own entries + subscribed repos
caveat list                         # recent entries
caveat community add <github-url>   # subscribe to a teammate / group repo
caveat community pull               # git-pull every subscribed repo
caveat community list               # show subscribed handles
caveat community remove <handle>    # unsubscribe + purge db rows
caveat pull                         # community pull + re-index everything
caveat serve                        # http://localhost:4242 read-only portal
caveat uninstall                    # reverse `caveat init` Claude integration
```

## Sharing with a team

There is no `caveat push` (since v0.7). To share with teammates, use plain git:

1. Create a GitHub repo (private or public), e.g. `acme-corp/caveats`, with an `entries/` directory.
2. Either point your `knowledgeRepo` at that repo (write directly to it) or copy shareable entries into it by hand. Then `git push` as usual.
3. Each teammate runs `caveat community add https://github.com/acme-corp/caveats` once, and `caveat pull` to refresh.

Trust is defined socially — by who has write access to your group repo — instead of by automated content gates on stranger PRs.

## MCP tools (6)

Exposed to Claude Code via the MCP server that `caveat init` registers:

`caveat_search`, `caveat_get`, `caveat_record`, `caveat_update`, `caveat_list_recent`, `caveat_pull`.

Claude can autonomously pull subscribed-repo updates (safe, idempotent). Recording / updating writes to your local `~/.caveat/own/` only — sharing is done by you via `git push` to your group repo.

## Pointing at a different knowledge repo

If you want `~/.caveat/own/` to live elsewhere (e.g. a git-tracked directory you sync to a team repo), override in `~/.caveatrc.json`:

```json
{ "knowledgeRepo": "/absolute/path/to/your/caveats-repo" }
```

## Requirements

- Node 22.5+ (for built-in `node:sqlite`)
- `git` for `caveat community add` / `caveat community pull`
- Claude Code installed if you want MCP / hooks integration. Without it, `caveat init --skip-claude` still provisions local state.

## License

MIT
