import { motionDuration } from '$lib/components/ui/reveal/index.js';

/**
 * The parts of a panel arrive one after the other, a beat apart: the fields
 * of a form, the rows of a dialog's step. Used as an action on the container
 * whose DIRECT CHILDREN are the parts (`use:stagger`), so nothing has to be
 * annotated one by one. Each child gets its own delay as a custom property,
 * and app.css plays them; a reader who asked for no motion gets the panel
 * whole, at once.
 */
export interface StaggerOptions {
  /** The beat between two parts, in ms. */
  step?: number;
  /** How long the first part waits, in ms. */
  delay?: number;
}

export function stagger(node: HTMLElement, options: StaggerOptions = {}) {
  const apply = ({ step = 42, delay = 50 }: StaggerOptions) => {
    node.setAttribute('data-stagger', '');
    // Only what is there when the panel arrives is part of the arrival. A
    // block that folds open later (a Reveal) has its own entrance: played
    // under this one as well, it sat at opacity 0 and then popped.
    [...node.children].forEach((child, i) => {
      child.setAttribute('data-stagger-item', '');
      (child as HTMLElement).style.setProperty('--stagger-delay', `${delay + i * step}ms`);
    });
  };
  apply(options);
  return {
    update: apply,
    destroy() {
      node.removeAttribute('data-stagger');
    }
  };
}

/**
 * What a part is never: the wrappers a page is built from. `staggerParts`
 * walks THROUGH them and stops at the first thing a reader would name (a
 * title, a field, a button row), whatever the page nested it in.
 */
const THROUGH = [
  '[data-slot="card"]',
  '[data-slot="card-header"]',
  '[data-slot="card-content"]',
  '[data-slot="card-footer"]',
  'form',
  // a panel that staggers its own children: its parts join the one sequence
  '[data-stagger]',
  '.auto-h',
  '.auto-h-inner',
  '.swap',
  '.panel'
].join(',');

function partsOf(node: Element): HTMLElement[] {
  return [...node.children].flatMap((child) =>
    child.matches(THROUGH) && child.children.length > 0 ? partsOf(child) : [child as HTMLElement]
  );
}

/**
 * The same arrival for a whole page whose parts are NOT siblings: a gate's
 * right leaf, where the eyebrow, the card's title, its sentence, each field
 * and the links under them sit at different depths. One sequence runs
 * through all of them in reading order (it overrides the delay a nested
 * `use:stagger` gave its own children, so a form inside does not start its
 * count again). Set once, when the page arrives: what a page shows later
 * (an error line, a swapped form) is not part of the arrival.
 */
export function staggerParts(node: HTMLElement, { step = 45, delay = 150 }: StaggerOptions = {}) {
  const parts = partsOf(node);
  parts.forEach((part, i) => {
    part.setAttribute('data-stagger-part', '');
    part.style.setProperty('--stagger-delay', `${delay + i * step}ms`);
  });
  return {
    destroy() {
      for (const part of parts) part.removeAttribute('data-stagger-part');
    }
  };
}

/** How long a whole panel takes to assemble, for a caller that waits on it. */
export function staggerDuration(count: number, { step = 42, delay = 50 }: StaggerOptions = {}): number {
  return delay + Math.max(0, count - 1) * step + motionDuration(2.4);
}
