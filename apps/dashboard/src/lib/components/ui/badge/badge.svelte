<script lang="ts" module>
  import { type VariantProps, tv } from 'tailwind-variants';
  export const badgeVariants = tv({
    // Status pills, the brand way: soft washes with a 7px dot in the status
    // color, never a saturated fill; hierarchy from the wash, not weight.
    base: 'focus:ring-ring inline-flex select-none items-center rounded-md border text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2',
    variants: {
      variant: {
        default:
          'border-transparent bg-[var(--accent-soft)] text-foreground before:mr-1.5 before:size-[7px] before:shrink-0 before:rounded-full before:bg-[var(--accent)] before:content-[""]',
        secondary: 'border-transparent bg-[var(--ground-3)] text-ink-soft',
        destructive:
          'border-transparent bg-[var(--danger-soft)] text-[var(--danger)] before:mr-1.5 before:size-[7px] before:shrink-0 before:rounded-full before:bg-[var(--danger)] before:content-[""]',
        outline: 'text-foreground',
        version: 'border-transparent bg-[var(--accent-soft)] text-foreground font-mono',
        old: 'border-transparent bg-[var(--warn-soft)] text-[var(--warn)] before:mr-1.5 before:size-[7px] before:shrink-0 before:rounded-full before:bg-[var(--warn)] before:content-[""] font-mono',
        latest:
          'border-transparent bg-[var(--ok-soft)] text-[var(--ok)] before:mr-1.5 before:size-[7px] before:shrink-0 before:rounded-full before:bg-[var(--ok)] before:content-[""] font-mono',
        accepted:
          'border-transparent bg-[var(--accent-soft)] text-foreground before:mr-1.5 before:size-[7px] before:shrink-0 before:rounded-full before:bg-[var(--accent)] before:content-[""] font-mono',
        inactive: 'border-transparent bg-[var(--ground-3)] text-brand-muted font-mono'
      }
    },
    defaultVariants: {
      variant: 'default'
    }
  });

  export type BadgeVariant = VariantProps<typeof badgeVariants>['variant'];
</script>

<script lang="ts">
  import { cn } from '$lib/utils.js';
  import type { WithElementRef } from 'bits-ui';
  import type { HTMLAnchorAttributes } from 'svelte/elements';

  let {
    ref = $bindable(null),
    href,
    class: className,
    variant = 'default',
    padding = 'px-2.5 py-0.5',
    children,
    ...restProps
  }: WithElementRef<HTMLAnchorAttributes> & {
    variant?: BadgeVariant;
    padding?: string;
  } = $props();
</script>

<svelte:element
  this={href ? 'a' : 'span'}
  bind:this={ref}
  {href}
  class={cn(badgeVariants({ variant }), padding, className)}
  {...restProps}
>
  {@render children?.()}
</svelte:element>
