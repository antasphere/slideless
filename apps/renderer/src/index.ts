import { ConfigError, loadConfig } from './config.js';
import { createLog } from './log.js';
import { CaptureQueue } from './queue.js';
import { ChromiumRenderer } from './renderer.js';
import { runSelfCheck } from './selfcheck.js';
import { createRendererServer } from './server.js';
import { SlidelessClient } from './slideless.js';

/**
 * The Slideless renderer (PRDCT-2725): a sandboxed Chromium behind a
 * one-endpoint queue. Boot: the environment, the server (answering 503
 * `starting` until ready), the self-check (Chromium sandboxed, nothing
 * reached but the fixture's files), then jobs.
 */
const STOP_GRACE_MS = 25_000;

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      for (const p of e.problems) createLog('error').error(p);
      process.exit(1);
    }
    throw e;
  }
  const log = createLog(config.logLevel);
  log.info('slideless renderer starting', {
    port: config.port,
    queueDepth: config.queueDepth,
    chromiumPath: config.chromiumPath,
    captureTimeoutMs: config.captureTimeoutMs
  });

  const renderer = new ChromiumRenderer({
    executablePath: config.chromiumPath,
    timeoutMs: config.captureTimeoutMs
  });
  const slideless = new SlidelessClient({ baseUrl: config.slidelessUrl, log });
  const queue = new CaptureQueue({ renderer, slideless, log, depth: config.queueDepth });
  let ready = false;
  const server = createRendererServer({ config, queue, log, ready: () => ready });

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info('stopping', { signal, queued: queue.size });
    queue.stop();
    server.close();
    server.closeIdleConnections();
    const grace = new Promise<void>((r) => setTimeout(r, STOP_GRACE_MS).unref());
    void Promise.race([queue.drain(), grace]).then(() => process.exit(0));
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => resolve());
  });
  log.info('listening; running the self-check before taking jobs', { host: config.host, port: config.port });

  const check = await runSelfCheck(renderer);
  if (check.code !== 0) {
    log.error(check.message ?? 'the self-check failed', { code: check.code, summary: check.summary });
    if (check.code === 3) {
      log.error(
        "Chromium's sandbox cannot start in this container: run it under the seccomp profile " +
          'deploy/seccomp-chromium.json (security_opt: seccomp=./deploy/seccomp-chromium.json). ' +
          'The renderer never runs Chromium unsandboxed.'
      );
    }
    process.exit(check.code);
  }
  if (stopping) return;
  ready = true;
  log.info('ready', { selfCheckMs: check.summary.ms });
}

main().catch((e: unknown) => {
  process.stdout.write(
    `${JSON.stringify({ level: 'error', time: new Date().toISOString(), msg: e instanceof Error ? (e.stack ?? e.message) : String(e) })}\n`
  );
  process.exit(1);
});
