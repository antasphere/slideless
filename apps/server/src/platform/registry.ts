import type { EntitlementService, IdentityProvider, UsageSink } from '@slideless/contract';
import type { EventBus } from './events.js';
import type { WorkspaceService } from './workspaces.js';

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
  /**
   * Workspace lifecycle (ADR 012). Setup creates the FIRST workspace through
   * it; product flows that open workspace creation (the cloud edition's lazy
   * org projection) call it here instead of inserting rows themselves.
   */
  workspaces: WorkspaceService;
}

export function createRegistry(defaults: PlatformRegistry): PlatformRegistry {
  return { ...defaults };
}
