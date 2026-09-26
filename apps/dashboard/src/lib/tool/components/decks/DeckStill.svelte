<script lang="ts">
  /* One deck version as a still picture (PRDCT-2725): the WebP the server
     captured when that version was pushed, served to everyone who can read
     the deck. The cards, the version rows and the reference sheet show it
     instead of loading the deck in a scaled-down frame, since nobody clicks
     into a card's picture. It is asked for once the box has been in view.

     The loader, in the `state` prop: while the image is fetched or still being made, a
     skeleton block fills the box with a soft shimmer, shown only after 150 ms
     so a fast answer never flashes it (plain, no shimmer, for a reader who
     asked for no motion). The image fades in over it (320 ms), then the
     skeleton is gone. When there is none, the skeleton fades out (200 ms) and
     whatever the parent draws beneath (the still pattern plate) shows
     through. It is only a picture: no pointer events, hidden from assistive
     technology when it carries no alt. */
  import { loadStill, type StillState } from '$lib/tool/decks/stills';

  interface Props {
    deckId: string;
    version: number;
    alt?: string;
    class?: string;
    /** idle before the box has been in view, loading, loaded once the image is shown, none when there is no image. */
    state?: StillState;
  }

  let { deckId, version, alt = '', class: className, state: current = $bindable('idle') }: Props = $props();

  const SKELETON_DELAY_MS = 150;
  const FADE_IN_MS = 320;
  const FADE_OUT_MS = 200;

  let box = $state<HTMLElement | null>(null);
  let seen = $state(false);
  let url = $state<string | null>(null);
  let skeleton = $state(false);

  $effect(() => {
    if (!box || seen) return;
    if (typeof IntersectionObserver === 'undefined') {
      seen = true;
      return;
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        seen = true;
        io.disconnect();
      }
    });
    io.observe(box);
    return () => io.disconnect();
  });

  $effect(() => {
    if (!seen) return;
    let live = true;
    url = null;
    current = 'loading';
    void loadStill(deckId, version).then((u) => {
      if (!live) return;
      url = u;
      if (!u) current = 'none';
    });
    return () => {
      live = false;
    };
  });

  // The skeleton: shown 150 ms into a load, kept under the image while it
  // fades in, faded out when there is none, then removed.
  $effect(() => {
    const s = current;
    if (s === 'loading') {
      if (skeleton) return;
      const id = setTimeout(() => (skeleton = true), SKELETON_DELAY_MS);
      return () => clearTimeout(id);
    }
    if (!skeleton) return;
    const id = setTimeout(() => (skeleton = false), s === 'loaded' ? FADE_IN_MS : FADE_OUT_MS);
    return () => clearTimeout(id);
  });
</script>

<span
  bind:this={box}
  class={['still', className].filter(Boolean).join(' ')}
  aria-hidden={alt ? undefined : 'true'}
>
  {#if skeleton}
    <span class="skeleton" class:leaving={current === 'none'}></span>
  {/if}
  {#if url}
    <img
      src={url}
      {alt}
      decoding="async"
      draggable="false"
      class:loaded={current === 'loaded'}
      onload={() => (current = 'loaded')}
      onerror={() => (current = 'none')}
    />
  {/if}
</span>

<style>
  .still {
    position: absolute;
    inset: 0;
    display: block;
    pointer-events: none;
  }
  .skeleton {
    position: absolute;
    inset: 0;
    overflow: hidden;
    background: var(--ground-2);
    transition: opacity 200ms var(--motion-ease);
  }
  .skeleton.leaving {
    opacity: 0;
  }
  .skeleton::after {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(
      100deg,
      transparent 20%,
      color-mix(in oklab, var(--ground-3) 70%, transparent) 50%,
      transparent 80%
    );
    transform: translateX(-100%);
    animation: still-shimmer 1.4s linear infinite;
  }
  @media (prefers-reduced-motion: reduce) {
    .skeleton::after {
      display: none;
    }
  }
  @keyframes still-shimmer {
    to {
      transform: translateX(100%);
    }
  }
  img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    opacity: 0;
    transition: opacity 320ms var(--motion-ease);
  }
  img.loaded {
    opacity: 1;
  }
</style>
