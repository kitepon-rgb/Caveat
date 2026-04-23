# Changelog

All notable changes are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.11.1] — 2026-04-23

### Fixed
- **`package.json` `bin.caveat` path.** Removed the leading `./` from `"./dist/caveat.js"` so `npm publish` no longer emits `bin[caveat] script name ... was invalid and removed`. No behavioral change — npm was already normalizing the path at publish time, so installed 0.11.0 works correctly. This is a source-cleanup patch.

## [0.11.0] — 2026-04-23

### Changed (BREAKING)
- **`caveat_record` visibility is now auto-classified by Claude, not asked every time.** The v0.6.2 rule "AI must ASK the user public/private before every call — never auto-classify" is retired. The tool description in `caveat_record` / `caveat_update` now carries a binary criterion: `public` if a third party running the same external tool/spec could reproduce the gotcha, `private` if the trap is specific to your repo / workflow / intentional non-standard design / cross-project personal context. When unclear, prefer `private` (leak-safety). Explicit user instruction ("record this as private", "これは自分用にメモして") always overrides the automatic classification. Rationale: quo's 50 recorded entries at v0.10 classified cleanly under this criterion without human-in-the-loop overhead, and the mandatory-asking pattern was blocking the `private` tier from ever accumulating (cold-start problem). See [docs/private-tier-design.md](docs/private-tier-design.md) for the full argument.

### Added
- **Private tier as a first-class target.** Caveat's scope widens from "external spec gotchas only" to "also repo-specific non-obvious context that code reading cannot reconstruct" (behavior that looks wrong but is intentional, workarounds that survive until upstream is fixed, cross-project conventions). Private entries live alongside public ones in `~/.caveat/own/` but the pre-commit visibility gate keeps them out of any shared git repo. Retrieval is deliberately flat — no source-tier filter switch at search time — because body vocabulary naturally segregates the two (public entries contain external tool names; private entries contain repo-specific identifiers). The 2-token co-occurrence FTS rule stays uniform across tiers.
- **`caveat_search` filter: `visibility: 'public' | 'private' | 'all'`.** Optional, defaults to both. Hook-triggered retrieval (`UserPromptSubmit` / `PostToolUse` / `Stop`) stays flat; this filter is for cases where Claude explicitly narrows, e.g. when drafting externally-visible output and wants to exclude private notes from the signal pool.
- **`entries.last_hit_at` column (schema v2).** Every time an entry surfaces via retrieval (hook reminder or `caveat_search`), its `last_hit_at` is written with the current timestamp. Exposed via `markHit(db, keys)` in `@caveat/core` so the search path stays pure. Existing v1 databases auto-migrate on next `openDb` via `migrations/002_last_hit_at.sql`.
- **`caveat stale` CLI subcommand.** `caveat stale [--days N] [--visibility public|private] [--limit N]` lists entries that haven't been surfaced by retrieval for N days (default 90). Primary use: monthly review of private entries — if a 3-month-old private entry never surfaces, its body likely lacks the repo-specific identifiers it needs to co-occur with relevant prompts, so rewrite or delete.
- **Stop-hook reminder: classification hint.** When the Stop hook fires, the reminder now includes a one-line hint based on objective signals: "外部仕様調査あり → public 寄り" when the session used `WebSearch` or `WebFetch`, otherwise "外部調査なし → private 寄り". Plus a reminder to pick visibility per the `caveat_record` binary criterion. The machine never decides — the hint is input for Claude's judgment.
- **`caveat_record` description: write-style guidance for private entries.** The tool description now instructs: when recording with `visibility: private`, always include repo-specific identifiers (function names, file paths, class names, custom terminology) in the body so the entry can be retrieved by co-occurrence FTS when you touch that area again. Without this, private entries get buried under the 2-token co-occurrence rule.

### Changed
- **Total test count: 192 → 203** (+5 `markHit`, +2 schema v2 / migration, +5 `stale`, +1 integration). All tests green across 5 workspace packages.

### Deferred
- **Cross-machine private sync.** The pre-commit visibility gate still blocks `visibility: private` from being committed to `~/.caveat/own/`'s git remote, which means private entries currently live only on one machine. A separate private repo (with its own remote) is the expected path for multi-machine use but is not implemented in v0.11 — this is fine for single-machine operation, revisit when a concrete multi-machine need arises.

## [0.10.0] — 2026-04-22

### Added
- **PostToolUse hook (実行中発火) with async detached-worker pipeline.** Fires after every `tool_response: { is_error: true }`. The foreground hook does only two things — drain any pending reminders from prior workers and spawn a detached worker — and returns in ~20ms so Claude Code's turn latency is unaffected. The worker runs the co-occurrence FTS asynchronously and writes a reminder to a per-session pending file; the next hook invocation (which could be another PostToolUse or the next UserPromptSubmit) drains and emits it. Reference: `packages/core/src/pendingReminders.ts`, `apps/cli/src/commands/hookCmd.ts::runWorker`.
- **Symmetric 3-firing-point architecture.** Pre-fire (UserPromptSubmit) / mid-fire (PostToolUse async) / post-fire (Stop transcript-signal + FTS) all reuse `findCaveatsForPrompt`'s co-occurrence logic with different text inputs (prompt / tool error / aggregated session signals).
- `claudeInstall.ts` auto-registers `PostToolUse` alongside existing `UserPromptSubmit` and `Stop` entries on `caveat init`.

## [0.9.0] — 2026-04-22

### Changed
- **Stop hook (事後発火) rewritten from "always fire + generic reminder" to signal-gated + co-occurrence FTS.** The hook now parses the session transcript JSONL (`readSessionSignals`) and fires only when at least one objective struggle signal is present: `toolFailureCount > 0`, repeated same-file edits, `webSearchCount > 0`, `webFetchCount > 0`, or `bashRetryCount > 0`. No threshold tuning (0-or-1 gate). When firing, the reminder embeds the concrete signal numbers plus any existing caveats whose content co-occurs with the session's error snippets / search queries, nudging either `caveat_update` (if a match) or `caveat_record` (if new). Catches struggle the AI didn't self-report.

## [0.8.0] — 2026-04-22

### Changed
- **UserPromptSubmit hook (事前発火) rewritten from keyword-allowlist to co-occurrence FTS.** Tokenizes the prompt, runs a per-token FTS5 query, and counts how many distinct tokens co-occur in each entry. Only entries matching ≥ 2 distinct tokens are surfaced. No hardcoded keyword/stopword lists — a new gotcha category just needs a new `entries/*.md` file and the trigger self-extends. Rule design: a single common word like `make` / `new` can't fire a match on its own, but two+ technical tokens co-occurring in the same entry will. See [docs/plan.md#phase-15](docs/plan.md) and `feedback_no_hardcoded_lists` memory.

## [0.7.0] — 2026-04-19

### Removed (BREAKING)
- **Central shared community DB model abolished.** The "everyone subscribes to one upstream repo and contributes via fork+PR" architecture is retired. Trust is now defined socially via per-group git repos that subscribers add explicitly. See [README.md](README.md) and [docs/archive/auto-merge-design.md](docs/archive/auto-merge-design.md) for the rationale.
- **`caveat push` CLI command** — removed. Group/team sharing now uses plain `git push` to a repo the contributor has write access to.
- **`caveat_push` MCP tool** — removed. Claude no longer has a path to publicly publish caveats. Recording / updating writes to the user's local `~/.caveat/own/` only.
- **`pushEntry` core function and `pullShared` core function** — both removed. `caveat pull` now uses `communityPull` + per-source re-index inline.
- **`caveat init --skip-shared` flag** — removed (the bootstrap subscription it opted out of no longer exists).
- **Auto-subscription to `kitepon-rgb/Caveat`** in `caveat init` — removed. New installs get an empty knowledge base; subscribe explicitly with `caveat community add <github-url>`.
- **`sharedRepo` config field, `SHARED_REPO_URL` constant** — removed from `~/.caveatrc.json` and core defaults.
- **`docs/auto-merge-design.md`** — moved to `docs/archive/` (the design was abandoned before implementation; archived for historical context).
- **`.github/ISSUE_TEMPLATE/caveat_contribution.md`** — removed (manual PR contribution to a central DB is no longer the workflow).

### Changed
- **MCP tool count is now 6** (was 7): `caveat_search`, `caveat_get`, `caveat_record`, `caveat_update`, `caveat_list_recent`, `caveat_pull`.
- **`caveat init`** scaffolds local state and registers Claude Code integration; no network operations during init unless `--skip-claude` is also off.
- **Stop hook reminder** no longer nudges `caveat_push` (the tool no longer exists).
- **README / CONTRIBUTING / SECURITY / CLAUDE.md / docs/plan.md** rewritten to reflect the new "personal / group" model.

## [0.6.2] — 2026-04-19

### Changed
- **MCP tool descriptions rewritten for AI-correctness**. Every tool now defines what a "caveat" is in its own description (time-wasting traps in external specs — GPU/driver/CUDA versions, native-module builds, IDE/shell quirks, platform-specific behavior) so the tool is usable without shared context. Fixed the silent-not-found gotcha on `caveat_get` (IMPORTANT: pass `source` from search result). Clarified: `caveat_search` query has no FTS5 operators (plain tokens only); `caveat_update` array fields REPLACE rather than append; `caveat_pull` should not be called reflexively at session start; `caveat_record` must search first for duplicates and qualify entries before creating; `caveat_push` is a PUBLIC irreversible action requiring user confirmation.

### Added
- **`caveat_record` visibility is now REQUIRED in the MCP schema** — the AI must ask the user whether the entry is `public` (shareable to community DB) or `private` (local-only) before calling. No auto-classification: the user owns the knowledge and decides its reach.
- **`pushEntry` rejects `visibility: private` entries** with `status=visibility-private` before touching GitHub. Previously private entries could be silently pushed to the public community DB — the pre-commit hook only guarded the tool repo itself. Regression test added.

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
