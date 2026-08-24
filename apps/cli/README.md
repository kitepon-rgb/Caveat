<p align="center">
  <img src="https://raw.githubusercontent.com/kitepon-rgb/Caveat/main/.github/og.png" alt="Caveat — long-term memory layer for coding agents" width="100%">
</p>

# Caveat

[![npm](https://img.shields.io/npm/v/caveat-cli?color=cb3837&label=caveat-cli)](https://www.npmjs.com/package/caveat-cli)
[![CI](https://github.com/kitepon-rgb/Caveat/actions/workflows/ci.yml/badge.svg)](https://github.com/kitepon-rgb/Caveat/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/caveat-cli?color=blue)](https://github.com/kitepon-rgb/Caveat/blob/main/LICENSE)

> **Stop rediscovering the same trap.** Caveat is a long-term memory layer for Claude Code and Codex: record a hard-won external-spec quirk or repo-specific oddity once, and the relevant note surfaces before an AI repeats it.

🇯🇵 **日本語版**: [README.ja.md](https://github.com/kitepon-rgb/Caveat/blob/main/README.ja.md)

Built and maintained by [Quo](https://x.com/QLyun35332) at [kitepon.dev](https://kitepon.dev/en).

**Source / full docs**: [github.com/kitepon-rgb/Caveat](https://github.com/kitepon-rgb/Caveat)

## Install

```sh
npm install -g caveat-cli
caveat init                          # Claude Code MCP + hooks
caveat codex-hook install            # optional: native Codex hooks
caveat cursor-hook install           # optional: native Cursor hooks
```

On macOS with Homebrew Node, Caveat installs hook commands through the stable
`/opt/homebrew/bin/node` symlink when it points at the current Node binary. This
keeps Claude Code and Codex hooks working after Homebrew moves Node between
`/opt/homebrew/Cellar/node/<version>/...` directories.

`caveat init` (idempotent, `--dry-run` supported) does the Claude Code setup:

1. Scaffolds `~/.caveat/own/` (your personal knowledge repo) + `~/.caveat/index/caveat.db`
2. Registers the MCP server with Claude Code (`claude mcp add --scope user`)
3. Merges `UserPromptSubmit` / `PostToolUse` / `PostToolUseFailure` / `Stop` hooks into `~/.claude/settings.json` (existing entries preserved, backup written before any change)

Opt-out: `--skip-claude`. `caveat uninstall` reverses the Claude Code changes without touching `~/.caveat/`. **No central DB is auto-subscribed** — add knowledge sources explicitly with `caveat community add`.

For Codex, run `caveat codex-hook diagnostics` first if you want a health check,
then `caveat codex-hook install`. It registers Caveat-owned
`UserPromptSubmit`, `PostToolUse`, and `Stop` entries in `~/.codex/hooks.json`
and enables Codex's native hook runtime.

With either host enabled, Caveat surfaces matching entries at three moments:
before prompts, after failed tools, and after struggle-heavy sessions. Stop
reminders are queued for the next context-capable hook tick so the agent's final
answer is not cluttered by hook output.

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
caveat codex-hook diagnostics       # inspect Codex hook availability/install state
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

Codex uses native hooks rather than MCP for automatic surfacing. The optional
`codex-sidecar` commands remain available for bounded second opinions, review,
risk-check, and isolated work.

## Pointing at a different knowledge repo

If you want `~/.caveat/own/` to live elsewhere (e.g. a git-tracked directory you sync to a team repo), override in `~/.caveatrc.json`:

```json
{ "knowledgeRepo": "/absolute/path/to/your/caveats-repo" }
```

## Requirements

- Node 22.5+ (for built-in `node:sqlite`)
- `git` for `caveat community add` / `caveat community pull`
- Claude Code installed if you want Claude MCP / hooks integration. Without it, `caveat init --skip-claude` still provisions local state.
- Codex installed if you want native Codex hooks via `caveat codex-hook install`.
- Cursor installed if you want native Cursor hooks via `caveat cursor-hook install`.

Release install smoke:

```sh
npm uninstall -g caveat-cli
npm install -g caveat-cli
caveat --version
caveat init
caveat codex-hook install
caveat cursor-hook install
```

## License

MIT
