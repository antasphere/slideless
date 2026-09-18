<script lang="ts" module>
  import { tv, type VariantProps } from 'tailwind-variants';

  /* The floating material, at the size of a panel: the dialog's paper (the
     plate laid over the opaque bar colour, so nothing reads through), one
     hairline, the large shadow, and 16px on the corners that are free of the
     screen's edge. The surface rules live in the style block below. */
  export const sheetVariants = tv({
    base: 'sheet-surface data-[state=open]:animate-in data-[state=closed]:animate-out fixed z-50 gap-4 p-6 transition ease-in-out data-[state=closed]:duration-300 data-[state=open]:duration-500',
    variants: {
      side: {
        top: 'data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top inset-x-0 top-0 rounded-b-2xl border-b',
        bottom:
          'data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom inset-x-0 bottom-0 rounded-t-2xl border-t',
        left: 'data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left inset-y-0 left-0 h-full w-3/4 rounded-r-2xl border-r sm:max-w-sm',
        right:
          'data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right top-3 bottom-3 right-3 h-[calc(100%-1.5rem)] w-3/4 rounded-2xl border sm:max-w-sm'
      }
    },
    defaultVariants: {
      side: 'right'
    }
  });

  export type Side = VariantProps<typeof sheetVariants>['side'];
</script>

<script lang="ts">
  import { Dialog as SheetPrimitive, type WithoutChildrenOrChild } from 'bits-ui';
  import X from '@lucide/svelte/icons/x';
  import type { Snippet } from 'svelte';
  import SheetOverlay from './sheet-overlay.svelte';
  import { cn } from '$lib/utils.js';
  import { t } from '$lib/i18n';

  let {
    ref = $bindable(null),
    class: className,
    portalProps,
    side = 'right',
    children,
    ...restProps
  }: WithoutChildrenOrChild<SheetPrimitive.ContentProps> & {
    portalProps?: SheetPrimitive.PortalProps;
    side?: Side;
    children: Snippet;
  } = $props();
</script>

<SheetPrimitive.Portal {...portalProps}>
  <SheetOverlay />
  <SheetPrimitive.Content bind:ref class={cn(sheetVariants({ side }), className)} {...restProps}>
    {@render children?.()}
    <SheetPrimitive.Close class="sheet-close">
      <X class="size-4" />
      <span class="sr-only">{t('common.close')}</span>
    </SheetPrimitive.Close>
  </SheetPrimitive.Content>
</SheetPrimitive.Portal>

<style>
  /* Global on purpose: bits-ui renders the surface in a portal. Both rules
     are fenced by a `sheet-` class. `:where` keeps the surface's paper at no
     specificity, so a caller's own background (the phone sidebar) wins. */
  :global {
    :where(.sheet-surface) {
      background-color: var(--bar);
      background-image: linear-gradient(var(--plate-strong), var(--plate-strong));
      color: var(--ink);
      border-color: var(--hairline);
      box-shadow:
        var(--shadow-lg),
        0 28px 64px -24px rgb(28 25 21 / 0.35),
        inset 0 1px 0 var(--plate-edge);
    }
    .sheet-close {
      position: absolute;
      top: 14px;
      right: 14px;
      z-index: 3;
      display: inline-flex;
      width: 30px;
      height: 30px;
      align-items: center;
      justify-content: center;
      border-radius: 9px;
      color: var(--muted);
      transition:
        background-color var(--motion-duration) var(--motion-ease),
        color var(--motion-duration) var(--motion-ease);
    }
    .sheet-close:hover {
      background: color-mix(in oklab, var(--accent) 9%, transparent);
      color: var(--ink);
    }
    .sheet-close:focus-visible {
      outline: 2px solid var(--focus);
      outline-offset: 1px;
    }
    .sheet-close:disabled {
      pointer-events: none;
    }
  }
</style>
