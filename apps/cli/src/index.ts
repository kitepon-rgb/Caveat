import { Command } from 'commander';
import type { Confidence, Source } from '@caveat/core';
import { buildContext } from './context.js';
import { CAVEAT_VERSION } from './version.js';
import { stdoutLogger } from './logger.js';
import { runInit, runUninstall } from './commands/init.js';
import { runIndex } from './commands/indexCmd.js';
import { runSearch } from './commands/search.js';
import { runList } from './commands/list.js';
import { runShow } from './commands/show.js';
import { runStats } from './commands/stats.js';
import { runServe } from './commands/serve.js';
import { runMcpServer } from './commands/mcpServer.js';
import { runHook, type HookName } from './commands/hookCmd.js';
import { runPull } from './commands/pull.js';
import {
  runCommunityAdd,
  runCommunityList,
  runCommunityPull,
  runCommunityRemove,
} from './commands/community.js';

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
  .action(async (opts: { skipClaude: boolean; dryRun: boolean }) => {
    const ctx = buildContext(stdoutLogger);
    await runInit(ctx, {
      skipClaude: opts.skipClaude,
      dryRun: opts.dryRun,
    });
  });

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
  .action((opts: { full: boolean }) => {
    const ctx = buildContext(stdoutLogger);
    runIndex(ctx, { full: opts.full });
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
  .command('serve')
  .description('Start the read-only web share portal')
  .option('--port <n>', 'port number', (v) => Number(v), 4242)
  .action((opts: { port: number }) => {
    runServe({ port: opts.port });
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
    'Run a Claude Code hook. name: user-prompt-submit | post-tool-use | stop | worker',
  )
  .action(async (name: string, arg?: string) => {
    await runHook(name as HookName, arg);
  });

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
