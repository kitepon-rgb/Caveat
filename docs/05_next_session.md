# Next Session Handoff

Last updated: 2026-07-13.

## Status

Precision and runtime reliability work is complete and released. There are no
remaining release tasks for `caveat-cli@0.16.2` or codex-sidecar 0.3.6.

BugHub/dotagents integration was intentionally excluded. Caveat did not add a
duplicate diagnostics store, error reporter, outbox, acknowledgement, or
notification path.

## Released Artifacts

- `caveat-cli@0.16.2` is npm `latest`, globally installed, and available from
  <https://github.com/kitepon-rgb/Caveat/releases/tag/v0.16.2>.
- `codex-sidecar-core@0.3.6`, `codex-sidecar-cli@0.3.6`, and
  `codex-sidecar-mcp@0.3.6` are npm `latest`; CLI/MCP 0.3.6 are installed.
- codex-sidecar release:
  <https://github.com/kitepon-rgb/codex-sidecar/releases/tag/v0.3.6>.
- Caveat release tag `v0.16.2` resolves to exact green commit
  `fb059b82e0f1ce24dd20665fe6bfc71b643b17cc`.
- codex-sidecar release tag `v0.3.6` resolves to
  `581e81dd2bf9656adc71d2988ae089e1fb6b96a3`.

## Verification

- Caveat local gate: build, typecheck, release pack/install smoke, diff-check,
  and all 545 tests green (core 419 / CLI 88 / MCP 12 / Web 17 / hooks 9).
- Hook-search evaluation: all 410 cases and corpus/golden digests unchanged from
  the recorded baseline. Primary precision remained 155/257 (0.6031128405),
  positive recall 151/269 (0.56133829), and negative any-hit 52/141
  (0.3687943262).
- Consecutive six-job CI runs `29227144416` and `29227427125` are green across
  Ubuntu 24.04, Windows 2022/2025, and Node 22/24.
- codex-sidecar CI run `29226366326` is green; Luna low structured advisory was
  8/8 valid before release.
- Fresh registry install verified package version 0.16.2, executable mode 755,
  manifest bin, `caveat init`, Codex hook install idempotence, diagnostics,
  generated Claude/Codex config, and uninstall leaving zero Caveat Codex hooks.
- New Codex session returned `caveat-new-session-ok` with `gpt-5.6-luna` and no
  Caveat hook failure. Codex separately emitted one model-catalog refresh child
  timeout; the explicit Luna turn completed.
- Published sidecar advisory smoke passed independently for Stop and tool-error
  with `gpt-5.6-luna` low, `status: ok`, output schema, raw log, and matched
  thread/turn binding verified.
- Published-package Claude smoke passed with Haiku, budget cap `$0.05`,
  UserPromptSubmit/Stop success, and `caveat-claude-session-ok`.

## Operational Notes

- The raw Codex CLI fresh-session smoke may symlink the real `auth.json` into a
  temporary `CODEX_HOME`.
- The codex-sidecar advisory smoke must instead receive the canonical real
  `CODEX_HOME`. Sidecar deliberately opens canonical auth with `O_NOFOLLOW` for
  durable snapshot/lease safety, so passing the temporary auth symlink fails
  closed with `ELOOP`. The release checklist records the exact separation.
- Windows timing evidence is bounded characterization, not a universal latency
  guarantee: `community.test.ts` n=22 p95 12.905s and
  `autoSyncHook.test.ts` n=8 p95 14.186s. Both use a 20s child timeout with
  longer setup/cleanup/suite bounds and phase-labelled failures.
- Six open Dependabot PRs at closeout are distinct current dependency updates,
  not superseded duplicates. They were left untouched.

## Canonical References

- Release procedure: [`04_release_checklist.md`](04_release_checklist.md)
- Claude/Codex and sidecar contract:
  [`03_dual_agent_support.md`](03_dual_agent_support.md)
- Completed implementation, audit, timing, and release ledger:
  [`archive/11_precision_and_runtime_reliability.md`](archive/11_precision_and_runtime_reliability.md)
