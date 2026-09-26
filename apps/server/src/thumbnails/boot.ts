import type { Logger } from '@antasphere/chassis-server/logger';
import type { Env } from '../env.js';
import { HttpRendererClient, type RendererClient } from './renderer-client.js';

/**
 * The renderer this instance hands deck versions to (PRDCT-2725), or null
 * when there is none: the instance then makes no images, the read route
 * answers `thumbnail_unavailable` and the cards keep their drawn pattern.
 * The env schema refuses a URL without its secret at boot (env.ts).
 */
export function rendererClientFor(
  env: Pick<Env, 'SLIDELESS_RENDERER_URL' | 'SLIDELESS_RENDERER_SECRET'>,
  logger: Logger
): RendererClient | null {
  if (!env.SLIDELESS_RENDERER_URL || !env.SLIDELESS_RENDERER_SECRET) {
    logger.info(
      'thumbnails: no renderer configured (SLIDELESS_RENDERER_URL unset) — deck cards show their pattern'
    );
    return null;
  }
  logger.info({ renderer: env.SLIDELESS_RENDERER_URL }, 'thumbnails: renderer configured');
  return new HttpRendererClient({
    baseUrl: env.SLIDELESS_RENDERER_URL,
    secret: env.SLIDELESS_RENDERER_SECRET,
    logger
  });
}
