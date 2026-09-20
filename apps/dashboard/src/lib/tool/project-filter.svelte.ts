import type { Project } from '$lib/projects/types';
import { deckProjects } from './projects-client';
import {
  readProjectFilter,
  rememberedListName,
  standingFilter,
  writeProjectFilter,
  type ProjectFilterPage
} from './project-filter';

/**
 * The project filter as a page holds it (PRDCT-2584): the remembered choice,
 * the projects the dropdown offers, and the way back to "All projects" when
 * the remembered project is no longer the reader's.
 */
export interface ProjectFilter {
  /** The project the list is narrowed to, or null for all of them. */
  readonly projectId: string | null;
  /** What the dropdown offers; empty hides it. */
  readonly projects: Project[];
  load(): Promise<void>;
  choose(projectId: string | null): void;
  /** Back to all projects, and nothing remembered: the project is gone or no longer readable. */
  forget(): void;
  listName(base: string): string;
}

export function createProjectFilter(page: ProjectFilterPage): ProjectFilter {
  let projectId = $state(readProjectFilter(page));
  let projects = $state<Project[]>([]);

  function choose(next: string | null) {
    projectId = next;
    writeProjectFilter(page, next);
  }

  return {
    get projectId() {
      return projectId;
    },
    get projects() {
      return projects;
    },
    async load() {
      try {
        projects = await deckProjects.readableProjects();
      } catch {
        // no list of projects, no dropdown: the page lists every deck, since a
        // remembered project could not be widened back without the dropdown
        choose(null);
        return;
      }
      if (standingFilter(projectId, projects) !== projectId) choose(null);
    },
    choose,
    forget: () => choose(null),
    listName: (base) => rememberedListName(base, projectId)
  };
}
