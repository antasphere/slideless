/**
 * The band a page opens on is ONE element of the shell (HeroStage, in the app
 * layout): it stays while the pages change under it, and eases from the size
 * one page gives it to the size the next one does. A page never renders the
 * band: it says what its band holds (HeroBand does the saying), and this is
 * where the shell reads it.
 */
import type { Snippet } from 'svelte';

export interface Band {
  /** Who said it: one page's HeroBand. A new owner is a new page. */
  owner: symbol;
  drawing: string;
  seed: number;
  compact: boolean;
  words: Snippet;
  /** What the words say, when the page can tell: two pages that say the same
      (the tabs of one section) keep them on the band, without replaying them. */
  words_key?: string;
}

class Hero {
  current = $state.raw<Band | null>(null);

  show(band: Band) {
    this.current = band;
  }

  /** A page that leaves takes its band with it, unless the next page has
      already said its own: the two happen in one page change, in that order,
      so the leaving waits a moment before it counts. */
  hide(owner: symbol) {
    setTimeout(() => {
      if (this.current?.owner === owner) this.current = null;
    }, 40);
  }
}

export const hero = new Hero();
