# Changelog

All notable changes are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.1] — 2026-04-19

### Fixed
- **community path placement**: `community/` now lives at `<caveatHome>/community/` instead of nested inside `<knowledgeRepo>/community/`. External knowledge caches are no longer buried in the user's own repo. `caveat init` auto-migrates existing clones from the legacy location on first run.
- **`caveat push` DeprecationWarning**: replaced `spawnSync(cmd, args, { shell: true })` with a single-string shell invocation to avoid Node 24's "shell + args array" deprecation. `gh.cmd` / `git.cmd` resolution on Windows still works via the platform shell.
- **Dead imports** cleaned up in `push.ts`.

### Changed
- CLI version is now read from `package.json` at runtime (`apps/cli/src/version.ts`) instead of hardcoded. Single source of truth.
- `~/.caveat/own/.gitignore` template no longer lists `community/` (it lives outside the repo in v0.6.1+).

### Added
- Push dry-run unit tests (`packages/core/tests/push.test.ts`): validates not-found, invalid URL rejection, and the dry-run plan output shape. Gracefully skips when `gh` CLI is unavailable.
- `CHANGELOG.md` (this file).

## [0.6.0] — 2026-04-19

### Removed
- **NLM integration tools** (`nlm_brief_for`, `ingest_research`) and the `Frontmatter.brief_id` field. Both were thin wrappers over `caveat_record` — Claude can generate NotebookLM prompts in-context and record results with `confidence: tentative` directly. MCP tool surface is now 7 (was 9).

## [0.5.0] — 2026-04-19

### Changed
- **Merged the shared knowledge DB into the tool repo**. The former separate `kitepon-rgb/caveats-quo` repo was archived and deleted; all 35 entries moved to this repo's `entries/` directory. `SHARED_REPO_URL` now points at `https://github.com/kitepon-rgb/Caveat`. One repo to remember.
- `.gitignore` extended with `.obsidian/` and `community/` (the tool repo now also serves as an Obsidian vault).

### Migration
- Existing v0.3-0.4 users: `npm update -g caveat-cli && rm -rf ~/.caveat/community/caveats-quo && caveat init`.

## [0.4.0] — 2026-04-19

### Added
- **`caveat_pull` and `caveat_push` as MCP tools**. Claude Code can now autonomously fetch community updates and submit contributions, gated by Claude Code's tool permission prompt for the public-write direction.
- `packages/core/src/push.ts` (`pushEntry`) and `packages/core/src/pullShared.ts` (`pullShared`) extracted so both CLI and MCP share the same implementation.
- Stop-hook reminder nudges `caveat_push` for genuinely reusable caveats.

## [0.3.0] — 2026-04-19

### Added
- **Shared community knowledge DB model**. `caveat init` auto-subscribes to a default shared repo (`SHARED_REPO_URL` constant, overridable via `~/.caveatrc.json`'s `sharedRepo` field). Skippable with `--skip-shared`.
- **`caveat pull`**: refresh every subscribed community repo and re-index.
- **`caveat push <id>`**: contribute a user-owned caveat via fork + PR using the `gh` CLI. Supports `--dry-run`.

## [0.2.1] — 2026-04-19

### Added
- `caveat init` now writes a default `.gitignore` to the scaffolded knowledge repo (`*.private.md`, `.obsidian/`). Prevents accidental commit of per-user Obsidian state and flagged-private entries.

## [0.2.0] — 2026-04-19

### Removed
- **`source_project` auto-infer**. `caveat_record` no longer consults `projectRoots` to guess the source project from cwd; the field is always written as `null`. This prevents per-user project names from leaking into publicly-shared knowledge. The `CaveatConfig.projectRoots` field and the `inferSourceProject` function were also removed. Users wanting `source_project` for personal traceability can set it manually in the md file.

## [0.1.0] — 2026-04-19

### Added
- **Initial NPM release**. The CLI is distributable as a single public package (`caveat-cli`) with `caveat` as the bin. Workspace deps (`@caveat/core`, `@caveat/mcp`, `@caveat/web`) are bundled into the CLI via tsup `noExternal`.
- **`caveat init` as one-shot installer**: scaffolds `~/.caveat/`, registers the MCP server with Claude Code via `claude mcp add --scope user`, and merges `UserPromptSubmit` / `Stop` hooks into `~/.claude/settings.json`. Idempotent, `--dry-run` supported.
- **`caveat uninstall`**: reverses the Claude Code integration without touching local data.
- **CLI subcommands**: `caveat mcp-server` (stdio MCP entry), `caveat hook <user-prompt-submit|stop>` (hook handler). Eliminates the Phase 10 pattern of registering raw `.mjs` script paths — Claude Code config now only references the `caveat` CLI.
- **caveatHome path model**: `process.env.CAVEAT_HOME ?? ~/.caveat/`. DB at `<caveatHome>/index/caveat.db`, default knowledge repo at `<caveatHome>/own/`.
- **Build pipeline**: `dist/caveat.js` thin bootstrap wrapper suppresses the `node:sqlite` ExperimentalWarning before the ESM bundle's static imports fire. Post-build pass restores `node:` prefix stripped by esbuild. CJS deps handled via `createRequire` banner.

---

## v0 implementation phases (pre-NPM)

For the design history of the v0 feature set (Phase 0 through 11), see `docs/plan.md`. Those phases predate the NPM release and are captured in commit history on the `main` branch of `kitepon-rgb/Caveat`.
