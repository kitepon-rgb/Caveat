# caveat-cli

External spec gotcha knowledge base CLI — markdown + SQLite FTS5 + MCP server + Claude Code hooks.

**Source / full docs**: https://github.com/kitepon-rgb/Caveat

## Install

```sh
npm install -g caveat-cli
caveat init
```

`caveat init` creates `~/.caveat/`, registers the MCP server with Claude Code (via `claude mcp add --scope user`), and merges `UserPromptSubmit` / `Stop` hooks into `~/.claude/settings.json`. Existing hook entries are preserved; the settings file is backed up before any write. Run `caveat init --dry-run` to preview, or `caveat init --skip-claude` to skip Claude Code wiring.

## Basic usage

```sh
caveat search "rtx"         # FTS against your knowledge repo
caveat list                 # recent entries
caveat serve                # http://localhost:4242 read-only portal
caveat community add <url>  # shallow-clone another user's caveats repo
caveat uninstall            # reverse `caveat init` Claude integration
```

## Requirements

- Node 22.5+ (for built-in `node:sqlite`)
- Optional: Claude Code installed for MCP / hooks integration. Without it, `caveat init --skip-claude` still provisions the local knowledge repo + index.

## License

MIT
