import type { EventBus, PlatformRegistry } from '@antasphere/chassis-server/platform';

/** The deck domain's own events, carried by the chassis bus beside the generic ones. */
export type DeckEvents = {
  'presentation.created': { workspaceId: string; presentationId: string };
  'presentation.version_committed': { workspaceId: string; presentationId: string; version: number };
};

export type DeckEventBus = EventBus<DeckEvents>;
export type DeckRegistry = PlatformRegistry<DeckEvents>;
