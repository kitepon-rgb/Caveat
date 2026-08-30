# Next Session Handoff

Last updated: 2026-08-24.

## Status

`caveat-cli@0.17.6` fixes the Windows Claude hook command emitted by `caveat init`.
The CLI script path was left unquoted when it contained backslashes but no spaces;
Claude's POSIX hook shell consumed those backslashes and Node resolved a broken
cwd-relative module path. The shared installer now quotes whitespace or backslash
paths, migrates existing commands without losing environment prefixes, and factory
diagnostics rejects the legacy unsafe shape.

## Previous Release (v0.17.5)

`caveat-cli@0.17.5` released from the first all-green four-environment CI run
(32622740838). Two closure items over 0.17.4: (1) the FOX Windows runner
failures were root-caused to ESET Network Attack Protection (IDS) falsely
flagging high-frequency loopback connections as a port scan and intermittently
blocking 127.0.0.1 machine-wide — permanent fix is an IDS exception (remote IP
127.0.0.1, block: no) with all protections left ON; the mingw git/curl
`getaddrinfo() thread failed to start` checkout failures were the same root
cause because mingw's threaded resolver uses loopback internally. (2) The WSL2
mirrored-networking quirk (closed loopback ports hang instead of refusing) is
neutralized by passing an explicit `timeoutMs` to the unreachable-keyserver
test (673ed6c). Diagnosis route is recorded in the caveat DB
(`eset-web-loopback-http-fixture-git-https-caveat-ci`).

## Previous Release (v0.17.4)

`caveat-cli@0.17.4` released: behavior-preserving refactor that consolidates
OS-dependent branches into `packages/core/src/platform.ts`, shared installer
helpers into `apps/cli/src/installShared.ts`, and the harness-neutral hook
engine into `apps/cli/src/hookShared.ts` (Claude/Codex switched by a `HookHost`
config). No feature or behavior changes; 573 tests passing across all
workspaces. The separation rules are canonicalized in CLAUDE.md
(「OS依存・ホスト依存の分離規約」). There are no remaining release tasks.

## Previous Release (v0.17.0)

AutoSync propagation work is complete and released as `caveat-cli@0.17.0`.

The release closes a real multi-terminal failure: an entry recorded on the WSL2
machine never reached the macOS machine. The cause was structural, not a bug —
the 24-hour debounce applied independently to the sending and the receiving
machine, so propagation took up to two days, and nothing pushed until a Stop
hook happened to fire outside that window.

## Released Artifacts

- `caveat-cli@0.17.0` is npm `latest` and installed on all three machines
  (macOS 0.17.0, WSL2 0.17.0, Windows native 0.17.0).
- Release tag `v0.17.0` resolves to green commit
  `fe09f2fe60463c37e7fa00d5fb3852a9bf52fa59`.
- The tag was force-moved once before publish: it originally pointed at the
  version-bump commit, and the Windows ACL fix landed after it. Nothing had been
  published at that point, so the tag now matches the published bytes.

## What Shipped

- Automatic sync runs at most every 15 minutes instead of every 24 hours.
- `caveat_record` / `caveat_update` trigger a background sync directly (60s
  burst floor) via the required `McpContext.onEntryWritten` seam, so a new entry
  no longer waits for the session to end.
- Repeated own-sync failures back off to a 6-hour retry instead of suspending
  until a manual `caveat sync`, and re-announce every 24 hours instead of going
  silent forever after one escalation notice.
- Notification signatures derive from the message text alone; folding internal
  dispositions in made identical messages re-notify on every state flip.
- `CAVEAT_AUTO_SYNC_DEBOUNCE_MS` garbage no longer parses to `NaN` and disables
  the debounce entirely.
- Windows ACL seam: 3s timeout raised to 15s, and failures now name their mode.

## Verification

- Local gate: build, typecheck, `check:release-smoke`, `check:npm-pack`,
  `git diff --check`, and all 570 tests green (core 437 / CLI 94 / MCP 13 /
  Web 17 / hooks 9).
- CI runs `29565434227` and `29565925548` are green across Ubuntu 24.04,
  Windows 2022/2025, and Node 22/24.
- Published-package smoke: fresh `npm install -g caveat-cli@0.17.0` into a
  temporary prefix reported version 0.17.0, `dist/caveat.js` mode 755, and
  `bin.caveat = dist/caveat.js`. The ACL fix is present in the published bundle.
- End-to-end propagation was verified against the real failure, not a fixture:
  `caveat sync` on WSL2 pushed 6 stranded entries, autosync on macOS pulled and
  reindexed them, and `caveat_search` then returned the WSL2-authored entry.

## Operational Notes

- The Windows ACL flake was diagnosed, not silenced. It had been "stabilized"
  three times (42f0451 / 0c4678f / 07a84b2) because the seam swallowed
  PowerShell's stderr and collapsed spawn failure, timeout, and non-zero exit
  into one `store_unsafe`. Decisive evidence was duration: the failing test ran
  3039ms against a 3000ms bound, while green runs ran it in 1042-1319ms. One
  apply costs 331-459ms on the runners themselves (measured via a throwaway
  diagnostic PR, #24, closed after collection). A developer workstation measures
  ~200ms and will not reproduce it — do not size CI bounds from a fast idle box.
- Do not wrap root scripts in `corepack`. `corepack pnpm <script>` exports
  `COREPACK_ROOT`, and `scripts/pnpm.mjs` prefers `PATH` pnpm, which then
  refuses to self-switch to the pinned 10.0.0 and fails hard. This bit the
  pre-publish gate; the checklist and CLAUDE.md now say `pnpm <script>`.
- `apps/cli` bundles workspace deps from their `dist/`, not `src/`. Rebuild in
  dependency order (`pnpm -r build`) — skipping `apps/mcp` ships a stale MCP
  while typecheck and tests still pass.
- Non-login SSH shells (WSL2 included) do not restore the npm prefix PATH, so a
  globally installed `caveat` looks missing. Use `bash -lc`. Recorded as
  `login-ssh-wsl2-npm-prefix-path-cli`.
- Six open Dependabot PRs at closeout are distinct current dependency updates,
  not superseded duplicates. They were left untouched.

## Canonical References

- AutoSync contract: `CLAUDE.md` (自動同期（AutoSync）)
- Release procedure: [`04_release_checklist.md`](../04_release_checklist.md)
- Claude/Codex and sidecar contract:
  [`03_dual_agent_support.md`](../03_dual_agent_support.md)
- Sharing and reindex design:
  [`06_sharing_and_reindex.md`](06_sharing_and_reindex.md)
