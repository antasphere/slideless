<script lang="ts">
  import { cn } from '$lib/utils.js';
  import X from '@lucide/svelte/icons/x';
  import { Dialog as DialogPrimitive, type WithoutChildrenOrChild } from 'bits-ui';
  import type { Snippet } from 'svelte';
  import { t } from '$lib/i18n';
  import * as Dialog from './index.js';

  let {
    ref = $bindable(null),
    class: className,
    portalProps,
    children,
    closable = true, // New parameter - defaults to true (current behavior)
    ...restProps
  }: WithoutChildrenOrChild<DialogPrimitive.ContentProps> & {
    portalProps?: DialogPrimitive.PortalProps;
    children: Snippet;
    closable?: boolean; // New optional parameter
  } = $props();
</script>

<Dialog.Portal {...portalProps}>
  <Dialog.Overlay />
  <DialogPrimitive.Content
    bind:ref
    class={cn(
      'fixed left-[50%] top-[50%] z-[60] grid w-[calc(100vw-3rem)] max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border bg-background p-5 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:w-[calc(100vw-6rem)] sm:max-w-2xl lg:w-[calc(100vw-8rem)]',
      className
    )}
    {...restProps}
  >
    {@render children?.()}

    <!-- Only render close button if closable is true -->
    {#if closable}
      <DialogPrimitive.Close
        class="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground"
      >
        <X class="size-4" />
        <span class="sr-only">{t('common.close')}</span>
      </DialogPrimitive.Close>
    {/if}
  </DialogPrimitive.Content>
</Dialog.Portal>
