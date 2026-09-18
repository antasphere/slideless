<script lang="ts" module>
  import { type VariantProps, tv } from 'tailwind-variants';
  /* A badge is a Tag that holds a snippet instead of a label: the same 24px
     label on paper, a wash of its tone under its own ink and one faint edge
     (ui/tag/tag.svelte). A state (latest, old, accepted, destructive) takes
     the tag's dot; the version variants keep the mono face. */
  export const badgeVariants = tv({
    base: 'badge',
    variants: {
      variant: {
        default: 'badge--accent',
        secondary: 'badge--neutral',
        destructive: 'badge--danger badge--dot',
        outline: 'badge--neutral',
        version: 'badge--slate badge--mono',
        old: 'badge--amber badge--dot badge--mono',
        latest: 'badge--green badge--dot badge--mono',
        accepted: 'badge--green badge--dot badge--mono',
        inactive: 'badge--neutral badge--mono'
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
    padding = 'px-2',
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

<style>
  .badge {
    --tone: var(--muted);
    display: inline-flex;
    align-items: center;
    gap: 5px;
    max-width: 100%;
    height: 24px;
    border: 1px solid color-mix(in oklab, var(--tone) 24%, transparent);
    border-radius: 7px;
    background: color-mix(in oklab, var(--tone) 11%, var(--plate-strong));
    color: color-mix(in oklab, var(--tone) 62%, var(--ink));
    font-family: var(--ui);
    font-size: 12.5px;
    font-weight: 500;
    line-height: 1;
    letter-spacing: 0;
    white-space: nowrap;
    vertical-align: middle;
    user-select: none;
  }
  a.badge:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 1px;
  }
  .badge--accent {
    --tone: var(--accent);
  }
  .badge--green {
    --tone: #2e8a74;
  }
  .badge--amber {
    --tone: #c7822f;
  }
  .badge--slate {
    --tone: #5c7285;
  }
  .badge--danger {
    --tone: #b4552f;
  }
  .badge--neutral {
    border-color: var(--hairline);
    background: var(--ground-2);
    color: var(--ink-soft);
  }
  .badge--mono {
    font-family: var(--mono);
    font-size: 11.5px;
    font-weight: 400;
  }
  /* a state rather than a kind: the tag's dot */
  .badge--dot::before {
    content: '';
    flex: none;
    width: 6px;
    height: 6px;
    margin: 0 2px 0 1px;
    border-radius: 50%;
    background: var(--tone);
    box-shadow: 0 0 0 3px color-mix(in oklab, var(--tone) 18%, transparent);
  }
</style>
