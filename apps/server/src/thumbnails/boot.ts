import { existsSync } from 'node:fs';
import type { Logger } from '@antasphere/chassis-server/logger';
import type { Env } from '../env.js';
import { ChromiumRenderer, type ThumbnailRenderer } from './renderer.js';

/**
 * The renderer this process captures deck images with (PRDCT-2725), or null
 * when it captures none: switched off, an api-only replica (the worker
 * captures; the api replica's rows wait for it), or no Chromium at the
 * configured path. A null renderer answers `thumbnail_unavailable` on the
 * read route and leaves the queued rows for a process that can capture.
 */
export function thumbnailRendererFor(
  env: Pick<Env, 'SLIDELESS_THUMBNAILS' | 'SLIDELESS_CHROMIUM_PATH' | 'SERVICE_ROLE'>,
  logger: Logger
): ThumbnailRenderer | null {
  if (env.SLIDELESS_THUMBNAILS === 'off') {
    logger.info('thumbnails: capture off (SLIDELESS_THUMBNAILS=off)');
    return null;
  }
  if (env.SERVICE_ROLE === 'api') return null;
  if (!existsSync(env.SLIDELESS_CHROMIUM_PATH)) {
    logger.warn(
      { path: env.SLIDELESS_CHROMIUM_PATH },
      'thumbnails: capture off — no Chromium at SLIDELESS_CHROMIUM_PATH'
    );
    return null;
  }
  return new ChromiumRenderer({ executablePath: env.SLIDELESS_CHROMIUM_PATH });
}
