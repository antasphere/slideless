<script lang="ts">
  import { cn } from '$lib/utils.js';
  import type { Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';
  import * as Dialog from './index.js';

  let {
    title,
    titleSnippet,
    description,
    icon,
    children,
    footer,
    class: className,
    headerClass,
    contentClass,
    footerClass,
    ...restProps
  }: {
    title?: string;
    titleSnippet?: Snippet;
    description?: string;
    icon?: Snippet;
    children: Snippet;
    footer?: Snippet;
    class?: string;
    headerClass?: string;
    contentClass?: string;
    footerClass?: string;
  } & HTMLAttributes<HTMLDivElement> = $props();
</script>

<!-- min-w-0 (not overflow-hidden, which would clip the scroll container's
     negative margin) keeps wide children (e.g. horizontally scrolling chip
     rows) from inflating this grid item to their intrinsic width. -->
<div class={cn('flex h-full max-h-[80vh] min-w-0 flex-col p-1', className)} {...restProps}>
  <!-- Fixed Header -->
  <Dialog.Header class={cn('flex-shrink-0 border-b px-1 pb-4', headerClass)}>
    <div class="flex items-start gap-4">
      {#if icon}
        <div class="flex-shrink-0">
          {@render icon()}
        </div>
      {/if}
      <div class="min-w-0 flex-1 overflow-hidden">
        {#if titleSnippet}
          {@render titleSnippet()}
        {:else if title}
          <Dialog.Title>{title}</Dialog.Title>
        {/if}
        {#if description}
          <Dialog.Description class="mt-2">{description}</Dialog.Description>
        {/if}
      </div>
    </div>
  </Dialog.Header>

  <!-- Scrollable Container. -mr-6 cancels Dialog.Content's p-5 + the root's p-1
	     so the scrollbar sits flush against the dialog's right border; pr-7 pads
	     the content back to align with the header/footer content edge. -->
  <div class="-mr-6 flex-1 overflow-y-auto overflow-x-hidden">
    <div class={cn('min-w-0 py-6 pl-1 pr-7', contentClass)}>
      {@render children()}
    </div>
  </div>

  <!-- Fixed Footer -->
  {#if footer}
    <Dialog.Footer class={cn('flex-shrink-0 border-t px-1 pt-4', footerClass)}>
      {@render footer()}
    </Dialog.Footer>
  {/if}
</div>
