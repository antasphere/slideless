/**
 * The one seam between the decks and their projects (PRDCT-2582, PRDCT-2584):
 * which decks a project holds, which projects a deck sits in, the project's
 * brand.
 *
 * STUB UNTIL THE REBASE: the server half (`GET /presentations?project=`, the
 * `projects` field of a deck's payload, `PUT|DELETE
 * /presentations/{id}/projects/{projectId}`, `PUT /projects/{id}/brand`) lands
 * on dev from the sister lane. Until then `deckProjects` reads the real decks
 * from `api` and keeps the links in memory, so every page can be built and
 * walked, on an instance with no deck too. At the rebase the body of this file
 * becomes calls on `api` from `$lib/api`, the `DeckProjectsClient` shape stays,
 * and no component changes: every component reads project data through this
 * file and nothing else.
 */
import type { Presentation, PresentationsListType } from '@slideless/contract';
import { api } from '$lib/api';
import { projects, StubApiError } from '$lib/projects/client';
import type { Project } from '$lib/projects/types';

/** A project as a deck's payload names it: only the ones the caller can read. */
export interface DeckProjectRef {
  id: string;
  name: string;
  /** The deck is this project's brand. */
  isBrand: boolean;
}

/** A deck as the list and the deck route will answer it once the server half is in. */
export type DeckWithProjects = Presentation & { projects?: DeckProjectRef[] };

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
  /** A deck id sets or changes the brand, `null` clears it. The deck stays linked. */
  setBrand(projectId: string, deckId: string | null): Promise<void>;
  /** The projects a filter or a picker can offer: the reader's own, archived ones left out. */
  readableProjects(): Promise<Project[]>;
}

/** An answer that says "not there, or not yours": the API's error and the stub's both carry `status`. */
export function isNotFound(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'status' in e && e.status === 404;
}

// ── The stub's memory ────────────────────────────────────────────────────
// deck id → the ids of its projects, and project id → the id of its brand
const links = new Map<string, Set<string>>();
const brands = new Map<string, string>();
const names = new Map<string, string>();

async function learnNames(): Promise<void> {
  const { projects: rows } = await projects.list({ archived: 'all' });
  for (const p of rows) names.set(p.id, p.name);
}

// So that a project has something to show: the first decks of the instance
// sit in the first projects. An instance with no deck seeds nothing.
let seeding: Promise<void> | null = null;
function seeded(): Promise<void> {
  return (seeding ??= (async () => {
    await learnNames();
    const [first, second] = [...names.keys()];
    try {
      const { presentations } = await api.presentations({ limit: 5 });
      presentations.slice(0, 3).forEach((d) => first && put(d.id, first));
      presentations.slice(2, 4).forEach((d) => second && put(d.id, second));
    } catch {
      // no deck to read: the projects start empty
    }
  })());
}

function put(deckId: string, projectId: string): void {
  links.set(deckId, new Set([...(links.get(deckId) ?? []), projectId]));
}

function refsOf(deckId: string): DeckProjectRef[] {
  return [...(links.get(deckId) ?? [])].map((id) => ({
    id,
    name: names.get(id) ?? id,
    isBrand: brands.get(id) === deckId
  }));
}

const withProjects = (deck: Presentation): DeckWithProjects => ({ ...deck, projects: refsOf(deck.id) });

export const deckProjects: DeckProjectsClient = {
  async decksOf(projectId, p) {
    await seeded();
    // whoever cannot read the project gets 404, never 403
    if (projectId) await projects.get(projectId);
    const { presentations, nextCursor } = await api.presentations(p);
    const shown = projectId ? presentations.filter((d) => links.get(d.id)?.has(projectId)) : presentations;
    return { presentations: shown.map(withProjects), nextCursor };
  },
  named(deck) {
    return deck.projects ?? [];
  },
  async projectsOf(deckId) {
    await seeded();
    return refsOf(deckId);
  },
  async link(deckId, projectId) {
    await seeded();
    const project = await projects.get(projectId);
    if (project.archivedAt) throw new StubApiError(409, 'project_archived', 'This project is archived');
    names.set(project.id, project.name);
    put(deckId, projectId);
  },
  async unlink(deckId, projectId) {
    await seeded();
    const next = new Set(links.get(deckId) ?? []);
    next.delete(projectId);
    links.set(deckId, next);
    // the brand flag rides on the link: it goes with it
    if (brands.get(projectId) === deckId) brands.delete(projectId);
  },
  async brandOf(projectId) {
    await seeded();
    const deckId = brands.get(projectId);
    if (!deckId) return null;
    try {
      return await api.presentation(deckId);
    } catch (e) {
      // a brand the reader cannot read is no brand to them
      if (isNotFound(e)) return null;
      throw e;
    }
  },
  async setBrand(projectId, deckId) {
    await seeded();
    const project = await projects.get(projectId);
    if (project.archivedAt) throw new StubApiError(409, 'project_archived', 'This project is archived');
    if (deckId === null) {
      brands.delete(projectId);
      return;
    }
    const deck = await api.presentation(deckId);
    if (deck.reference?.type !== 'brand')
      throw new StubApiError(422, 'not_a_brand', 'This deck is not a brand');
    put(deckId, projectId);
    brands.set(projectId, deckId);
  },
  async readableProjects() {
    const { projects: rows } = await projects.list({ archived: 'false' });
    for (const p of rows) names.set(p.id, p.name);
    return rows;
  }
};
