<script lang="ts">
  /* The one graphic on a deck's banner: what kind of deck it is, drawn still
     in the hand of the section drawings (three stroke weights, 1, 1.2 and one
     emphasised 1.6, ink at low opacity, boxes filled with a breath of paper,
     the accent used ONCE). A presentation is a few fanned slides, an app a
     window with its panes, a plan a written page. It sits on a field, so its
     ink is the field's (as `.on-field`), not the theme's. Nothing moves and
     nothing answers the pointer: it is a picture, not a control. */
  import type { PresentationKind } from '@slideless/contract';

  interface Props {
    kind: PresentationKind;
  }
  let { kind }: Props = $props();
</script>

<svg viewBox="0 0 200 132" class="art" aria-hidden="true">
  {#if kind === 'app'}
    <!-- a window: its bar, a side pane, two panes of content -->
    <rect class="bx" x="22" y="14" width="156" height="104" rx="9" />
    <line class="ln ln--thin" x1="22" y1="34" x2="178" y2="34" />
    <circle class="ring" cx="34" cy="24" r="2.6" />
    <circle class="ring" cx="43" cy="24" r="2.6" />
    <circle class="ring" cx="52" cy="24" r="2.6" />
    <line class="ln ln--thin" x1="66" y1="34" x2="66" y2="118" />
    <line class="ln ln--thin" x1="31" y1="47" x2="56" y2="47" />
    <line class="ln ln--thin" x1="31" y1="57" x2="50" y2="57" />
    <line class="ln ln--thin" x1="31" y1="67" x2="54" y2="67" />
    <rect class="ln" x="77" y="45" width="42" height="28" rx="4" />
    <rect class="ln" x="126" y="45" width="42" height="28" rx="4" />
    <path class="ln ln--soft" d="M82,66 L91,58 L98,62 L106,52 L114,56" />
    <line class="ln ln--thin" x1="77" y1="86" x2="150" y2="86" />
    <line class="ln ln--thin" x1="77" y1="96" x2="132" y2="96" />
    <line class="ln ln--c" x1="133" y1="59" x2="161" y2="59" />
  {:else if kind === 'plan'}
    <!-- a written page and the one behind it: a title, its lines, a tick -->
    <rect class="bx" x="72" y="10" width="86" height="110" rx="7" transform="rotate(5 115 65)" />
    <rect class="bx bx--front" x="48" y="12" width="86" height="110" rx="7" />
    <line class="ln ln--c" x1="60" y1="30" x2="98" y2="30" />
    <line class="ln ln--thin" x1="60" y1="44" x2="122" y2="44" />
    <line class="ln ln--thin" x1="60" y1="53" x2="116" y2="53" />
    <line class="ln ln--thin" x1="60" y1="62" x2="104" y2="62" />
    <rect class="ln ln--thin" x="60" y="76" width="9" height="9" rx="2.2" />
    <path class="ln" d="M62,80.6 L64.2,83 L67.6,78.4" />
    <line class="ln ln--thin" x1="76" y1="80.5" x2="118" y2="80.5" />
    <rect class="ln ln--thin" x="60" y="92" width="9" height="9" rx="2.2" />
    <line class="ln ln--thin" x1="76" y1="96.5" x2="110" y2="96.5" />
  {:else}
    <!-- three slides fanned out, the front one carrying a title and a figure -->
    <rect class="bx" x="62" y="20" width="112" height="70" rx="7" transform="rotate(9 118 55)" />
    <rect class="bx bx--mid" x="46" y="28" width="112" height="70" rx="7" transform="rotate(3 102 63)" />
    <rect class="bx bx--front" x="28" y="40" width="112" height="70" rx="7" transform="rotate(-4 84 75)" />
    <g transform="rotate(-4 84 75)">
      <line class="ln ln--c" x1="40" y1="56" x2="78" y2="56" />
      <line class="ln ln--thin" x1="40" y1="68" x2="98" y2="68" />
      <line class="ln ln--thin" x1="40" y1="77" x2="88" y2="77" />
      <line class="ln ln--thin" x1="40" y1="96" x2="62" y2="96" />
      <circle class="ring" cx="117" cy="86" r="11" />
      <path class="ln ln--soft" d="M117,75 A11,11 0 0 1 127.4,89.6" />
    </g>
  {/if}
</svg>

<style>
  .art {
    display: block;
    width: 100%;
    height: 100%;
    overflow: visible;
    color: #1c1915;
    --paper: 247 246 244;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  :global(:root.dark) .art {
    color: #f7f4ec;
    --paper: 20 16 12;
  }
  .ln {
    fill: none;
    stroke: color-mix(in oklab, currentColor 46%, transparent);
    stroke-width: 1.2;
  }
  .ln--soft {
    stroke: color-mix(in oklab, currentColor 36%, transparent);
    stroke-dasharray: 3 4;
  }
  .ln--thin {
    stroke: color-mix(in oklab, currentColor 30%, transparent);
    stroke-width: 1;
  }
  .bx {
    fill: rgb(var(--paper) / 0.22);
    stroke: color-mix(in oklab, currentColor 34%, transparent);
    stroke-width: 1;
  }
  .bx--mid {
    fill: rgb(var(--paper) / 0.34);
  }
  /* the sheet in front hides what is behind it, the way paper does */
  .bx--front {
    fill: rgb(var(--paper) / 0.62);
    stroke: color-mix(in oklab, currentColor 42%, transparent);
  }
  .ring {
    fill: none;
    stroke: color-mix(in oklab, currentColor 40%, transparent);
    stroke-width: 1;
  }
  /* the one place the accent goes */
  .ln--c {
    stroke: var(--accent);
    stroke-width: 1.6;
  }
</style>
