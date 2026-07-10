import type { EntitlementService, IdentityProvider, UsageSink } from '@slideless/contract';
import type { EventBus } from './events.js';

/**
 * Boot-time module registry: the single place where seam implementations are
 * bound. The template binds local defaults; a rail-connected or ee edition
 * re-binds its own implementations here at boot (Cal.com/n8n pattern) and
 * nothing else in the codebase changes.
 */
export interface PlatformRegistry {
  identity: IdentityProvider;
  entitlements: EntitlementService;
  usage: UsageSink;
  events: EventBus;
}

export function createRegistry(defaults: PlatformRegistry): PlatformRegistry {
  return { ...defaults };
}
