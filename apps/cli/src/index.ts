import { Command } from 'commander';
import type { Confidence, Source } from '@caveat/core';
import { buildContext } from './context.js';
import { stdoutLogger } from './logger.js';
import { runInit } from './commands/init.js';
import { runIndex } from './commands/indexCmd.js';
import { runSearch } from './commands/search.js';
import { runList } from './commands/list.js';
import { runShow } from './commands/show.js';
import { runStats } from './commands/stats.js';
import { runServe } from './commands/serve.js';
import {
  runCommunityAdd,
  runCommunityList,
  runCommunityPull,
} from './commands/community.js';

const program = new Command();
program
  .name('caveat')
  .description('External spec gotcha knowledge base CLI')
  .version('0.0.0');

program
  .command('init')
  .description('Initialize ~/.caveatrc.json and .index/caveat.db')
  .action(() => {
    const ctx = buildContext(stdoutLogger);
    runInit(ctx);
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
  .command('serve')
  .description('Start the read-only web share portal')
  .option('--port <n>', 'port number', (v) => Number(v), 4242)
  .action((opts: { port: number }) => {
    runServe({ port: opts.port });
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

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[caveat:error] ${msg}\n`);
  process.exit(1);
});
