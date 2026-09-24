<script lang="ts">
  /* One deck version as a still picture (PRDCT-2725): the WebP the server
     captured when that version was pushed, served to everyone who can read
     the deck. The cards, the version rows and the reference sheet show it
     instead of loading the deck in a scaled-down frame, since nobody clicks
     into a card's picture. It is asked for once the box has been in view,
     fades in when it has loaded, and draws nothing while it is being made or
     when there is none, so whatever the parent draws beneath (the pattern
     plate) shows through. It is only a picture: no pointer events, hidden
     from assistive technology when it carries no alt. */
  import { loadStill } from '$lib/tool/decks/stills';

  interface Props {
    deckId: string;
    version: number;
    alt?: string;
    class?: string;
    /** True once the image is shown. */
    loaded?: boolean;
  }

  let { deckId, version, alt = '', class: className, loaded = $bindable(false) }: Props = $props();

  let box = $state<HTMLElement | null>(null);
  let seen = $state(false);
  let url = $state<string | null>(null);

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
    loaded = false;
    void loadStill(deckId, version).then((u) => {
      if (live) url = u;
    });
    return () => {
      live = false;
    };
  });
</script>

<span
  bind:this={box}
  class={['still', className].filter(Boolean).join(' ')}
  aria-hidden={alt ? undefined : 'true'}
>
  {#if url}
    <img src={url} {alt} decoding="async" draggable="false" class:loaded onload={() => (loaded = true)} />
  {/if}
</span>

<style>
  .still {
    position: absolute;
    inset: 0;
    display: block;
    pointer-events: none;
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
