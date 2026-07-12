import type { Logger } from '../logger.js';

/**
 * Internal event bus: domain modules publish, platform modules (and later
 * rail/ee modules registered at boot) subscribe. Deliberately synchronous
 * fan-out with error isolation — a failing subscriber never breaks the
 * publisher's request path.
 */
export type PlatformEvents = {
  /**
   * Fired by the identity layer (Better Auth databaseHooks.user.create.after,
   * wired in boot) for EVERY account entrance — setup, invitation accept,
   * collaborator claim, future SSO JIT. Trustworthy by construction; call
   * sites never emit it.
   */
  'user.created': { userId: string; email: string };
  'member.joined': { workspaceId: string; userId: string; role: string };
  'member.updated': { workspaceId: string; userId: string };
  'member.removed': { workspaceId: string; userId: string };
  'apikey.created': { workspaceId: string; apiKeyId: string };
  'apikey.revoked': { workspaceId: string; apiKeyId: string };
  'invitation.created': { workspaceId: string; invitationId: string };
  'invitation.accepted': { workspaceId: string; invitationId: string; userId: string };
  'file.uploaded': { workspaceId: string; fileId: string; sizeBytes: number };
  'presentation.created': { workspaceId: string; presentationId: string };
  'presentation.version_committed': { workspaceId: string; presentationId: string; version: number };
  'setup.completed': { workspaceId: string; instanceId: string };
};

type Handler<E extends keyof PlatformEvents> = (payload: PlatformEvents[E]) => void | Promise<void>;

export class EventBus {
  private handlers = new Map<keyof PlatformEvents, Set<Handler<never>>>();

  constructor(private readonly logger: Logger) {}

  on<E extends keyof PlatformEvents>(event: E, handler: Handler<E>): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler as Handler<never>);
    this.handlers.set(event, set);
    return () => set.delete(handler as Handler<never>);
  }

  emit<E extends keyof PlatformEvents>(event: E, payload: PlatformEvents[E]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      Promise.resolve((handler as Handler<E>)(payload)).catch((err) => {
        this.logger.error({ err, event }, 'event handler failed');
      });
    }
  }
}
