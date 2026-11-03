import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { buildServer } from './server.js';

const config = loadConfig();
const log = createLogger(config.LOG_LEVEL, config.NODE_ENV === 'development');

const server = await buildServer(config, log);
await server.start();

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'received shutdown signal');
  // Hard limit so a stuck connection can't block a deploy forever.
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  await server.stop();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (err) => log.error({ err }, 'unhandled promise rejection'));
