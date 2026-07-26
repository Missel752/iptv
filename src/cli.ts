#!/usr/bin/env node
/** IPTV Nexus command line interface. */

import { Command, Option } from 'commander';
import { logger, type LogLevel } from './core/logger.js';
import { loadConfig, PATHS } from './core/config.js';
import { formatBytes, remove } from './core/fs.js';
import { aggregate } from './aggregate/index.js';
import { runHealthScan, pruneRetired } from './health/index.js';
import { buildEpg } from './epg/index.js';
import { runDiscovery } from './discovery/index.js';
import { buildApi } from './api/build.js';

const program = new Command();

program
  .name('iptv-nexus')
  .description('Self-updating IPTV channel, stream and EPG index with a free static API')
  .version('1.0.0')
  .addOption(
    new Option('-l, --log-level <level>', 'log verbosity')
      .choices(['debug', 'info', 'warn', 'error', 'silent'])
      .default('info'),
  )
  .hook('preAction', (command) => {
    const level = command.opts()['logLevel'] as LogLevel;
    logger.setLevel(level);
    process.env['LOG_LEVEL'] = level;
  });

// ---------------------------------------------------------------------------

program
  .command('aggregate')
  .description('Fetch upstream + configured sources and rebuild the dataset')
  .option('--upstream-only', 'skip third-party sources', false)
  .action(async (options: { upstreamOnly: boolean }) => {
    const dataset = await logger.time('Aggregate', () =>
      aggregate({ upstreamOnly: options.upstreamOnly }),
    );
    logger.info(`Channels: ${dataset.channels.length}, streams: ${dataset.stats.merged_streams}`);
  });

program
  .command('health')
  .description('Probe streams and update availability scores')
  .option('--shard-count <n>', 'total number of parallel shards', Number)
  .option('--shard-index <n>', 'this shard, 0-based', Number)
  .option('--limit <n>', 'check at most N streams', Number)
  .option('--min-age <minutes>', 'skip streams checked within this window', Number)
  .option('--concurrency <n>', 'override configured concurrency', Number)
  .option('-f, --force', 'ignore --min-age', false)
  .option('--prune', 'remove retired streams from the dataset afterwards', false)
  .action(
    async (options: {
      shardCount?: number;
      shardIndex?: number;
      limit?: number;
      minAge?: number;
      concurrency?: number;
      force: boolean;
      prune: boolean;
    }) => {
      const result = await logger.time('Health scan', () =>
        runHealthScan({
          shardCount: options.shardCount,
          shardIndex: options.shardIndex,
          limit: options.limit,
          minAgeMinutes: options.minAge,
          concurrency: options.concurrency,
          force: options.force,
        }),
      );
      logger.info(
        `online=${result.summary.online} offline=${result.summary.offline} ` +
          `blocked=${result.summary.blocked} avg score=${result.summary.average_score}`,
      );
      if (options.prune) {
        const pruned = await pruneRetired();
        logger.info(`Pruned ${pruned.removed} stream(s)`);
      }
    },
  );

program
  .command('epg')
  .description('Grab, normalise and match EPG guides, then emit XMLTV')
  .action(async () => {
    const result = await logger.time('EPG build', buildEpg);
    logger.info(
      `${result.programmes} programmes, ${result.epg_channels} channels, ` +
        `${result.unmatched.length} unmatched`,
    );
  });

program
  .command('discover')
  .description('Scan configured sources for new streams and write a proposal')
  .option('--skip-validation', 'do not probe candidates', false)
  .option('--max-probes <n>', 'cap the number of live probes', Number)
  .action(async (options: { skipValidation: boolean; maxProbes?: number }) => {
    const report = await logger.time('Discovery', () =>
      runDiscovery({ skipValidation: options.skipValidation, maxProbes: options.maxProbes }),
    );
    logger.info(`accepted=${report.accepted.length} rejected=${report.rejected.length}`);
  });

program
  .command('api')
  .description('Render the static JSON API, playlists and web site into public/')
  .option('--clean', 'wipe public/ first', false)
  .action(async (options: { clean: boolean }) => {
    const result = await logger.time('API build', () => buildApi({ clean: options.clean }));
    logger.info(`${result.files} files, ${formatBytes(result.bytes)}`);
  });

program
  .command('pipeline')
  .description('Run the full pipeline: aggregate → health → epg → api')
  .option('--skip-health', 'do not probe streams', false)
  .option('--skip-epg', 'do not rebuild the guide', false)
  .option('--health-limit <n>', 'cap streams probed in this run', Number)
  .action(
    async (options: { skipHealth: boolean; skipEpg: boolean; healthLimit?: number }) => {
      await logger.time('Pipeline', async () => {
        await aggregate();
        if (!options.skipHealth) {
          await runHealthScan({ limit: options.healthLimit, minAgeMinutes: 60 });
          await pruneRetired();
        }
        if (!options.skipEpg) await buildEpg();
        await buildApi({ clean: true });
      });
    },
  );

program
  .command('config')
  .description('Print the resolved configuration')
  .action(async () => {
    const config = await loadConfig();
    console.log(JSON.stringify(config, null, 2));
  });

program
  .command('clean')
  .description('Remove generated output')
  .option('--cache', 'also clear the HTTP cache', false)
  .option('--all', 'also clear persisted health and dataset state', false)
  .action(async (options: { cache: boolean; all: boolean }) => {
    await remove(PATHS.public);
    logger.info('Removed public/');
    if (options.cache || options.all) {
      await remove(PATHS.cache);
      logger.info('Removed HTTP cache');
    }
    if (options.all) {
      await remove(PATHS.data);
      logger.warn('Removed .data/ — health history is gone');
    }
  });

// ---------------------------------------------------------------------------

/**
 * `npm run cli -- health -- --limit 30` is a natural thing to type, but the
 * second `--` is commander's end-of-options separator: everything after it
 * becomes an operand and the flags are silently ignored. This CLI has no
 * positional arguments at all, so dropping bare `--` tokens is unambiguous and
 * makes both spellings work.
 */
const argv = process.argv.filter((token, index) => !(index >= 2 && token === '--'));

program.parseAsync(argv).catch((error: unknown) => {
  logger.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
