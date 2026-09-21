/**
 * The one seam between the decks and their projects (PRDCT-2582, PRDCT-2584):
 * which decks a project holds, which projects a deck sits in, the project's
 * brand. Every component reads project data through this file and nothing
 * else, so the deck side of projects knows the SDK by these eight calls. A
 * project the caller cannot read answers 404, like the project itself.
 */
import type { Presentation, PresentationProjectRef, PresentationsListType } from '@slideless/contract';
import { api } from '$lib/api';
import type { Project } from '$lib/projects/types';

/** A project as a deck's payload names it: only the ones the caller can read. */
export type DeckProjectRef = PresentationProjectRef;

/** A deck names its readable projects on the list and on its own route alike. */
export type DeckWithProjects = Presentation;

interface DeckPageParams {
  cursor?: string;
  limit?: number;
  /** The references pages keep their `type` filter beside the project's. */
  type?: PresentationsListType;
}

export interface DeckProjectsClient {
  /**
   * A page of decks, of one project or of all of them (`null`). Each deck
   * carries its readable projects. An unreadable project answers 404.
   */
  decksOf(
    projectId: string | null,
    p: DeckPageParams
  ): Promise<{ presentations: DeckWithProjects[]; nextCursor: string | null }>;
  /** What a deck's payload already says: no request. */
  named(deck: DeckWithProjects): DeckProjectRef[];
  /** The deck's readable projects, read fresh: the deck's page after a change. */
  projectsOf(deckId: string): Promise<DeckProjectRef[]>;
  link(deckId: string, projectId: string): Promise<void>;
  unlink(deckId: string, projectId: string): Promise<void>;
  brandOf(projectId: string): Promise<Presentation | null>;
  /**
   * A deck id sets or changes the brand, `null` clears it. The deck must
   * already be linked to the project (409 `not_linked` otherwise), and be a
   * brand reference (400 `not_a_brand`); it stays linked when cleared.
   */
  setBrand(projectId: string, deckId: string | null): Promise<void>;
  /** The projects a filter or a picker can offer: the reader's own, archived ones left out. */
  readableProjects(): Promise<Project[]>;
}

export { isNotFound } from '$lib/projects/errors';

export const deckProjects: DeckProjectsClient = {
  // the SDK's list takes `project` (ADR 026); an unreadable project answers 404 there as on the wire
  decksOf: (projectId, p) => api.presentations(projectId ? { ...p, project: projectId } : p),
  named: (deck) => deck.projects,
  projectsOf: async (deckId) => (await api.presentation(deckId)).projects,
  async link(deckId, projectId) {
    await api.linkPresentationProject(deckId, projectId);
  },
  async unlink(deckId, projectId) {
    await api.unlinkPresentationProject(deckId, projectId);
  },
  brandOf: async (projectId) => (await api.projectBrand(projectId)).brand,
  async setBrand(projectId, deckId) {
    if (deckId === null) await api.clearProjectBrand(projectId);
    else await api.setProjectBrand(projectId, deckId);
  },
  // one page is the whole offer: a person is in far fewer than a hundred projects
  readableProjects: async () => (await api.projects({ archived: 'false', limit: 100 })).projects
};
