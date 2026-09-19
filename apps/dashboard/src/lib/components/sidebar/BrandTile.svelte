<script lang="ts">
  /* A workspace's tile: its form (one pattern of the brand's library, drawn
     still) in its accent, on a soft wash of that accent over the plate, one
     hairline of the accent around. Nothing on it moves: its class is its own, never `.tile`, the pressable card that lifts under the pointer. The active
     workspace's tile follows the look store live (the settings page tries a
     look on it); another workspace's wears the look /me carries for it.
     Without a workspace (the instance's own header) the tile wears the
     current look. */
  import type { WorkspaceLook } from '@slideless/contract';
  import { formMask } from '$lib/brand/form';
  import { accentOf, look, resolveLook, type Look } from '$lib/look.svelte';
  import { theme } from '$lib/theme.svelte';

  interface Props {
    /** Kept for callers; the tile no longer seeds anything from it. */
    seedKey?: string;
    label?: string;
    /** The tile's side in px: 32 in the sidebar, 30 on the phone's top bar. */
    size?: number;
    class?: string;
    /** The workspace whose look the tile carries; '' for the current look. */
    workspaceId?: string;
    /** That workspace's look as /me carries it (another workspace than the active one). */
    wire?: WorkspaceLook | null;
    /** A look given outright (a preview of a workspace that does not exist yet). */
    preview?: Look;
  }

  let {
    seedKey = '',
    label = '',
    size = 32,
    class: className = '',
    workspaceId = '',
    wire,
    preview
  }: Props = $props();

  const own = $derived(
    preview ?? (workspaceId && workspaceId !== look.workspaceId ? resolveLook(workspaceId, wire) : look.value)
  );
  const colours = $derived(accentOf(own.theme, theme.dark));
  const mask = $derived(formMask(own.pattern, size));
  const title = $derived(label || seedKey);
</script>

<span
  class="brand-tile shrink-0 {className}"
  style="--t-size: {size}px; --t-accent: {colours.accent}; --t-soft: {colours.soft}; --t-hair: {colours.hairline}"
  data-pattern={own.pattern}
  aria-hidden="true"
  {title}
>
  <span class="form" style="-webkit-mask-image: url({mask}); mask-image: url({mask})"></span>
</span>

<style>
  .brand-tile {
    position: relative;
    display: inline-block;
    width: var(--t-size);
    height: var(--t-size);
    border-radius: calc(var(--t-size) * 0.26);
    overflow: hidden;
    background: linear-gradient(var(--t-soft), var(--t-soft)), var(--plate-strong);
    box-shadow: inset 0 0 0 1px var(--t-hair);
  }
  .form {
    position: absolute;
    inset: 0;
    background: var(--t-accent);
    -webkit-mask-size: 100% 100%;
    mask-size: 100% 100%;
    -webkit-mask-repeat: no-repeat;
    mask-repeat: no-repeat;
    -webkit-mask-position: center;
    mask-position: center;
  }
</style>
