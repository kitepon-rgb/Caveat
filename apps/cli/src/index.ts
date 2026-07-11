import { Command } from 'commander';
import type { Confidence, Source } from '@caveat/core';
import { buildContext } from './context.js';
import { CAVEAT_VERSION } from './version.js';
import { stdoutLogger } from './logger.js';
import { runInit, runUninstall } from './commands/init.js';
import { runIndex } from './commands/indexCmd.js';
import { runSearch } from './commands/search.js';
import { runList } from './commands/list.js';
import { runStale } from './commands/stale.js';
import { runShow } from './commands/show.js';
import { runStats } from './commands/stats.js';
import { runServe } from './commands/serve.js';
import { runMcpServer } from './commands/mcpServer.js';
import { runHook, type HookName } from './commands/hookCmd.js';
import { runCodexHook } from './commands/codexHookCmd.js';
import { installCodexHooks, uninstallCodexHooks } from './codexHookInstall.js';
import { runPull } from './commands/pull.js';
import { runSync } from './commands/sync.js';
import { runPublish } from './commands/publish.js';
import {
  runCodexSidecarDiagnostics,
  runCodexSidecarSmoke,
  runCodexSidecarWithCaveats,
  runCodexSidecarWorkSmoke,
} from './commands/codexSidecar.js';
import {
  runCommunityAdd,
  runCommunityList,
  runCommunityPull,
  runCommunityRemove,
} from './commands/community.js';
import { resolveHookNodePath } from './nodePath.js';

const program = new Command();
program
  .name('caveat')
  .description('External spec gotcha knowledge base CLI')
  .version(CAVEAT_VERSION);

program
  .command('init')
  .description(
    'Initialize ~/.caveatrc.json, ~/.caveat/, and register Claude Code integration. Add knowledge sources later with `caveat community add <github-url>`.',
  )
  .option('--skip-claude', 'skip Claude Code MCP + hook registration', false)
  .option('--dry-run', 'show planned changes without writing', false)
  .option(
    '--pending-stale-days <days>',
    'sweep `<caveatHome>/pending/<sessionId>/` whose newest entry is older than this (default 7)',
    (raw) => {
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(`--pending-stale-days expects a non-negative integer (got "${raw}")`);
      }
      return n;
    },
  )
  .action(
    async (opts: { skipClaude: boolean; dryRun: boolean; pendingStaleDays?: number }) => {
      const ctx = buildContext(stdoutLogger);
      await runInit(ctx, {
        skipClaude: opts.skipClaude,
        dryRun: opts.dryRun,
        pendingStaleDays: opts.pendingStaleDays,
      });
    },
  );

program
  .command('uninstall')
  .description('Remove Claude Code MCP server and hooks registered by `caveat init`')
  .option('--dry-run', 'show planned changes without writing', false)
  .action((opts: { dryRun: boolean }) => {
    const ctx = buildContext(stdoutLogger);
    runUninstall(ctx, { dryRun: opts.dryRun });
  });

program
  .command('index')
  .description('Index knowledge repo entries into SQLite')
  .option('--full', 'full rebuild (DELETE all then rescan)', false)
  .action(async (opts: { full: boolean }) => {
    const ctx = buildContext(stdoutLogger);
    await runIndex(ctx, { full: opts.full });
  });

program
  .command('search')
  .description('Search caveats via FTS')
  .argument('<query>', 'FTS query (3+ chars for trigram)')
  .option('--source <source>', 'own | community | all')
  .option('--tag <tag...>', 'filter by tag (repeatable)')
  .option('--confidence <confidence...>', 'filter by confidence (repeatable)')
  .action(
    (
      query: string,
      opts: {
        source?: 'own' | 'community' | 'all';
        tag?: string[];
        confidence?: string[];
      },
    ) => {
      const ctx = buildContext(stdoutLogger);
      runSearch(ctx, {
        query,
        source: opts.source,
        tags: opts.tag,
        confidence: opts.confidence as Confidence[] | undefined,
      });
    },
  );

program
  .command('list')
  .description('List caveats by updated_at DESC')
  .option('--recent <n>', 'number of entries', (v) => Number(v), 20)
  .action((opts: { recent: number }) => {
    const ctx = buildContext(stdoutLogger);
    runList(ctx, { limit: opts.recent });
  });

program
  .command('stale')
  .description(
    'List entries not surfaced by retrieval for N days (default 90). Use this to find private caveats that may be buried — if a 3-month-old private entry never surfaces, rewrite its body to include repo-specific identifiers, or delete it.',
  )
  .option('--days <n>', 'age threshold in days', (v) => Number(v), 90)
  .option('--visibility <v>', 'public | private')
  .option('--limit <n>', 'max rows', (v) => Number(v), 50)
  .action((opts: { days: number; visibility?: string; limit: number }) => {
    const ctx = buildContext(stdoutLogger);
    const vis =
      opts.visibility === 'public' || opts.visibility === 'private' ? opts.visibility : undefined;
    runStale(ctx, { days: opts.days, visibility: vis, limit: opts.limit });
  });

program
  .command('show')
  .description('Show full caveat by id')
  .argument('<id>', 'entry id')
  .option('--source <source>', 'own or community/<handle>', 'own')
  .action((id: string, opts: { source: string }) => {
    const ctx = buildContext(stdoutLogger);
    runShow(ctx, { id, source: opts.source as Source });
  });

program
  .command('stats')
  .description('Show aggregate stats')
  .action(() => {
    const ctx = buildContext(stdoutLogger);
    runStats(ctx);
  });

program
  .command('pull')
  .description(
    'git-pull every subscribed community repo and re-index. Use this to receive updates from group/teammate repos.',
  )
  .action(async () => {
    const ctx = buildContext(stdoutLogger);
    await runPull(ctx);
  });

program
  .command('sync')
  .description('Sync own Caveat entries to a private git remote')
  .option('--init [url]', 'initialize private remote sync (optionally with its URL)')
  .option('--repo <url>', 'private remote URL (requires --init)')
  .option('--dry-run', 'show pending own-repo changes without writing', false)
  .option('--trust-remote-private', 'continue when anonymous remote visibility cannot be determined', false)
  .option('--yes', 'approve creating the default GitHub private repository', false)
  .action(async (opts: {
    init?: boolean | string;
    repo?: string;
    dryRun: boolean;
    trustRemotePrivate: boolean;
    yes: boolean;
  }) => {
    const ctx = buildContext(stdoutLogger);
    await runSync(ctx, opts);
  });

program
  .command('publish')
  .description('Mirror own public Caveat entries to a public git repository')
  .option('--init <url>', 'set the public mirror target')
  .option('--dry-run', 'show public mirror changes without committing or pushing', false)
  .option('--yes', 'approve creating a default repository or publishing changes', false)
  .action(async (opts: { init?: string; dryRun: boolean; yes: boolean }) => {
    const ctx = buildContext(stdoutLogger);
    await runPublish(ctx, opts);
  });

program
  .command('serve')
  .description('Start the read-only web share portal')
  .option('--port <n>', 'port number', (v) => Number(v), 4242)
  .action(async (opts: { port: number }) => {
    await runServe({ port: opts.port });
  });

program
  .command('mcp-server')
  .description('Run the MCP stdio server (registered by `caveat init`)')
  .action(async () => {
    await runMcpServer();
  });

program
  .command('hook <name> [arg]')
  .description(
    'Run a Claude Code hook. name: user-prompt-submit | post-tool-use | stop | worker | reindex',
  )
  .action(async (name: string, arg?: string) => {
    await runHook(name as HookName, arg);
  });

const codexHook = program
  .command('codex-hook')
  .description('Install or run Codex hooks for Caveat');

codexHook
  .command('install')
  .description('Install Caveat hooks into ~/.codex/hooks.json and enable codex_hooks')
  .option('--dry-run', 'show planned changes without writing', false)
  .option('--codex-home <path>', 'Codex home directory', process.env.CODEX_HOME ?? `${process.env.HOME}/.codex`)
  .action((opts: { dryRun: boolean; codexHome: string }) => {
    const cliScriptPath = process.argv[1];
    if (!cliScriptPath) {
      process.stderr.write('[caveat:error] cannot determine CLI script path\n');
      process.exit(1);
    }
    const result = installCodexHooks({
      codexHome: opts.codexHome,
      cliScriptPath,
      nodePath: resolveHookNodePath(),
      dryRun: opts.dryRun,
      logger: stdoutLogger,
    });
    stdoutLogger.info(`UserPromptSubmit hook: ${result.hooks.userPromptSubmit}`);
    stdoutLogger.info(`PostToolUse hook: ${result.hooks.postToolUse}`);
    stdoutLogger.info(`Stop hook: ${result.hooks.stop}`);
    stdoutLogger.info(`codex_hooks feature: ${result.feature}`);
    if (result.backupPath) stdoutLogger.info(`hooks.json backed up: ${result.backupPath}`);
    if (result.configBackupPath) {
      stdoutLogger.info(`config.toml backed up: ${result.configBackupPath}`);
    }
  });

codexHook
  .command('uninstall')
  .description('Remove Caveat-owned Codex hooks from ~/.codex/hooks.json')
  .option('--dry-run', 'show planned changes without writing', false)
  .option('--codex-home <path>', 'Codex home directory', process.env.CODEX_HOME ?? `${process.env.HOME}/.codex`)
  .action((opts: { dryRun: boolean; codexHome: string }) => {
    const cliScriptPath = process.argv[1];
    if (!cliScriptPath) {
      process.stderr.write('[caveat:error] cannot determine CLI script path\n');
      process.exit(1);
    }
    const result = uninstallCodexHooks({
      codexHome: opts.codexHome,
      cliScriptPath,
      nodePath: resolveHookNodePath(),
      dryRun: opts.dryRun,
      logger: stdoutLogger,
    });
    stdoutLogger.info(`UserPromptSubmit hook: ${result.hooks.userPromptSubmit === 'added' ? 'removed' : 'not present'}`);
    stdoutLogger.info(`PostToolUse hook: ${result.hooks.postToolUse === 'added' ? 'removed' : 'not present'}`);
    stdoutLogger.info(`Stop hook: ${result.hooks.stop === 'added' ? 'removed' : 'not present'}`);
    if (result.backupPath) stdoutLogger.info(`hooks.json backed up: ${result.backupPath}`);
  });

codexHook
  .command('diagnostics')
  .description('Check local Codex hook availability')
  .option('--codex-home <path>', 'Codex home directory', process.env.CODEX_HOME ?? `${process.env.HOME}/.codex`)
  .action(async (opts: { codexHome: string }) => {
    await runCodexHook('diagnostics', opts.codexHome);
  });

codexHook
  .command('user-prompt-submit')
  .description('Run the Codex UserPromptSubmit hook')
  .action(async () => {
    await runCodexHook('user-prompt-submit');
  });

codexHook
  .command('post-tool-use')
  .description('Run the Codex PostToolUse hook')
  .action(async () => {
    await runCodexHook('post-tool-use');
  });

codexHook
  .command('stop')
  .description('Run the Codex Stop hook')
  .action(async () => {
    await runCodexHook('stop');
  });

codexHook
  .command('worker <workFile>')
  .description('Run the detached Codex hook worker')
  .action(async (workFile: string) => {
    await runCodexHook('worker', workFile);
  });

const codexSidecar = program
  .command('codex-sidecar')
  .description('Check Codex sidecar availability for the current repository');

codexSidecar
  .command('diagnostics')
  .description('Run codex-sidecar diagnostics for this repository')
  .option('--project <path>', 'repository root to check')
  .option('--preset <preset>', 'codex-sidecar preset', 'review')
  .option('--command <command>', 'codex-sidecar executable', 'codex-sidecar')
  .option('--node-cli <path>', 'development path to codex-sidecar CLI JS')
  .option('--save-result <path>', 'write structured SidecarResult JSON to this path')
  .action((opts: { project?: string; preset?: string; command?: string; nodeCli?: string; saveResult?: string }) => {
    runCodexSidecarDiagnostics(stdoutLogger, opts);
  });

codexSidecar
  .command('smoke')
  .description('Run a read-only codex_explore smoke through codex-sidecar')
  .option('--project <path>', 'repository root to check')
  .option('--preset <preset>', 'codex-sidecar read-only preset', 'explore')
  .option('--command <command>', 'codex-sidecar executable', 'codex-sidecar')
  .option('--node-cli <path>', 'development path to codex-sidecar CLI JS')
  .option('--save-result <path>', 'write structured SidecarResult JSON to this path')
  .action((opts: { project?: string; preset?: string; command?: string; nodeCli?: string; saveResult?: string }) => {
    runCodexSidecarSmoke(stdoutLogger, opts);
  });

codexSidecar
  .command('run <workflow> [prompt]')
  .description('Run read-only codex-sidecar with relevant Caveat entries as context')
  .option('--project <path>', 'repository root to check')
  .option('--preset <preset>', 'codex-sidecar preset')
  .option('--query <query>', 'Caveat search query; defaults to prompt text')
  .option('--limit <n>', 'maximum caveat entries to pass', (v) => Number(v), 5)
  .option('--source <source>', 'own | community | all', 'all')
  .option('--visibility <visibility>', 'public | private | all', 'all')
  .option('--host-agent <agent>', 'claude | codex | automation | unknown', 'unknown')
  .option('--availability <level>', 'disabled | unavailable | configured | operational | work-capable', 'operational')
  .option('--sidecar-agent <agent>', 'codex | disabled | auto')
  .option('--requires-isolation', 'mark the sidecar call as isolation-bounded', false)
  .option('--structured-result-required', 'mark structured SidecarResult as the delegation boundary', false)
  .option('--explicit-second-pass', 'mark the sidecar call as an explicit second-pass review', false)
  .option('--command <command>', 'codex-sidecar executable', 'codex-sidecar')
  .option('--node-cli <path>', 'development path to codex-sidecar CLI JS')
  .option('--save-result <path>', 'write structured SidecarResult JSON to this path')
  .action(
    (
      workflow: string,
      prompt: string | undefined,
      opts: {
        project?: string;
        preset?: string;
        query?: string;
        limit: number;
        source: 'own' | 'community' | 'all';
        visibility: 'public' | 'private' | 'all';
        hostAgent: 'claude' | 'codex' | 'automation' | 'unknown';
        availability: 'disabled' | 'unavailable' | 'configured' | 'operational' | 'work-capable';
        sidecarAgent?: 'codex' | 'disabled' | 'auto';
        requiresIsolation: boolean;
        structuredResultRequired: boolean;
        explicitSecondPass: boolean;
        command?: string;
        nodeCli?: string;
        saveResult?: string;
      },
    ) => {
      const normalized =
        workflow === 'risk' ? 'risk-check' : workflow;
      if (
        normalized !== 'review' &&
        normalized !== 'explore' &&
        normalized !== 'opinion' &&
        normalized !== 'risk-check'
      ) {
        process.stderr.write('[caveat:error] workflow must be review | explore | opinion | risk-check\n');
        process.exit(1);
      }
      const ctx = buildContext(stdoutLogger);
      runCodexSidecarWithCaveats(ctx, normalized, prompt, opts);
    },
  );

codexSidecar
  .command('work-smoke [prompt]')
  .description('Run codex_work in an isolated worktree and remove it after verification')
  .option('--project <path>', 'repository root to check')
  .option('--preset <preset>', 'codex-sidecar work preset', 'work')
  .option('--command <command>', 'codex-sidecar executable', 'codex-sidecar')
  .option('--node-cli <path>', 'development path to codex-sidecar CLI JS')
  .option('--save-result <path>', 'write structured SidecarResult JSON to this path')
  .action(
    (
      prompt: string | undefined,
      opts: { project?: string; preset?: string; command?: string; nodeCli?: string; saveResult?: string },
    ) => {
      const ctx = buildContext(stdoutLogger);
      runCodexSidecarWorkSmoke(ctx, prompt, opts);
    },
  );

const community = program
  .command('community')
  .description('Manage community caveat repos (shallow clones under <knowledgeRepo>/community/)');

community
  .command('add <url>')
  .description('Shallow-clone a GitHub caveat repo into community/<handle>/')
  .action(async (url: string) => {
    const ctx = buildContext(stdoutLogger);
    await runCommunityAdd(ctx, url);
  });

community
  .command('pull')
  .description('git pull all community repos')
  .action(async () => {
    const ctx = buildContext(stdoutLogger);
    await runCommunityPull(ctx);
  });

community
  .command('list')
  .description('List imported community repos with entry counts')
  .action(() => {
    const ctx = buildContext(stdoutLogger);
    runCommunityList(ctx);
  });

community
  .command('remove <handle>')
  .description('Unsubscribe from a community repo: delete community/<handle>/ and purge its DB rows')
  .option('--dry-run', 'show what would be removed without touching disk or db', false)
  .action((handle: string, opts: { dryRun: boolean }) => {
    const ctx = buildContext(stdoutLogger);
    runCommunityRemove(ctx, handle, { dryRun: opts.dryRun });
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[caveat:error] ${msg}\n`);
  process.exit(1);
});
