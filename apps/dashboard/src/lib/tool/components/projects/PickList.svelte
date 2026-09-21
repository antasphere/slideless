<script lang="ts">
  /* One choice among a few rows, inside a dialog: the brand of a project, the
     deck to add to it, the project a deck joins. A radio group drawn as rows.

     SECURITY: titles and details are USER-AUTHORED; text interpolation only. */
  interface Item {
    id: string;
    title: string;
    detail?: string;
  }

  interface Props {
    items: Item[];
    value: string | null;
    /** The group's name, for assistive technology. */
    label: string;
  }

  let { items, value = $bindable(), label }: Props = $props();
</script>

<div class="pick" role="radiogroup" aria-label={label}>
  {#each items as item (item.id)}
    <button
      type="button"
      role="radio"
      class="row"
      aria-checked={value === item.id}
      onclick={() => (value = item.id)}
    >
      <span class="mark" aria-hidden="true"></span>
      <span class="words">
        <span class="title">{item.title}</span>
        {#if item.detail}<span class="detail">{item.detail}</span>{/if}
      </span>
    </button>
  {/each}
</div>

<style>
  .pick {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    width: 100%;
    min-width: 0;
    padding: 10px 12px;
    border: 1px solid var(--hairline);
    border-radius: 8px;
    background: transparent;
    text-align: left;
    font: inherit;
    color: inherit;
    transition:
      border-color var(--motion-duration) var(--motion-ease),
      background-color var(--motion-duration) var(--motion-ease);
  }
  .row:hover {
    background: color-mix(in oklab, var(--ink) 4%, transparent);
  }
  .row[aria-checked='true'] {
    border-color: color-mix(in oklab, var(--accent) 55%, var(--hairline));
    background: color-mix(in oklab, var(--accent) 6%, transparent);
  }
  .mark {
    flex: none;
    width: 14px;
    height: 14px;
    margin-top: 3px;
    border-radius: 999px;
    border: 1px solid color-mix(in oklab, var(--ink) 40%, transparent);
  }
  .row[aria-checked='true'] .mark {
    border-color: var(--accent);
    background: radial-gradient(circle, var(--accent) 0 3.5px, transparent 4.5px);
  }
  .words {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .title {
    font-size: 14px;
    overflow-wrap: anywhere;
  }
  .detail {
    font-size: 13px;
    color: var(--muted);
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }
</style>
