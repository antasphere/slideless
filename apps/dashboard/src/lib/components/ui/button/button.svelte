<script lang="ts" module>
  import type { WithElementRef } from 'bits-ui';
  import type { HTMLAnchorAttributes, HTMLButtonAttributes } from 'svelte/elements';
  import { type VariantProps, tv } from 'tailwind-variants';

  export const buttonVariants = tv({
    base: 'focus-visible:ring-ring inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[10px] text-[13.5px] font-medium tracking-normal transition-[color,background-color,border-color,box-shadow,transform] focus-visible:outline-none focus-visible:ring-1 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
    variants: {
      variant: {
        // The one action of a page: ink on paper, the way a printed form sets
        // its button. No gradient, no grain, no pill. A hairline of light on
        // its top edge, and under the pointer it lifts and its edge takes the
        // accent, so the look a person picked still shows on it.
        default:
          'bg-[var(--ink)] text-[var(--ground)] shadow-[inset_0_1px_0_rgb(255_255_255/0.14),0_1px_2px_rgb(28_25_21/0.18)] hover:scale-[1.012]',
        // The accent is a clay (dawn) and danger IS the ember: two filled
        // clays side by side read as one button. Danger is therefore a wash
        // at rest and only fills under the hand.
        destructive:
          'bg-[var(--danger-soft)] text-[var(--danger)] border border-[color-mix(in_oklab,var(--danger)_35%,transparent)] hover:bg-[var(--danger)] hover:text-[var(--accent-ink)]',
        outline:
          'bg-[var(--plate-strong)] border border-[var(--hairline)] text-[var(--ink)] hover:border-[color-mix(in_oklab,var(--accent)_45%,var(--hairline))] hover:bg-[color-mix(in_oklab,var(--accent)_6%,var(--plate-strong))]',
        secondary:
          'bg-[var(--accent-soft)] text-[var(--accent-deep)] hover:bg-[color-mix(in_oklab,var(--accent)_20%,transparent)]',
        ghost: 'hover:bg-[color-mix(in_oklab,var(--accent)_8%,transparent)] hover:text-foreground',
        link: 'text-primary underline-offset-4 hover:underline'
      },
      size: {
        default: 'h-9 px-4 py-2',
        xs: 'h-8 px-2 text-xs',
        sm: 'h-8 px-3 text-[13px]',
        lg: 'h-10 px-8',
        icon: 'h-9 w-9'
      }
    },
    defaultVariants: {
      variant: 'default',
      size: 'default'
    }
  });

  export type ButtonVariant = VariantProps<typeof buttonVariants>['variant'];
  export type ButtonSize = VariantProps<typeof buttonVariants>['size'];

  export type ButtonProps = WithElementRef<HTMLButtonAttributes> &
    WithElementRef<HTMLAnchorAttributes> & {
      variant?: ButtonVariant;
      size?: ButtonSize;
    };
</script>

<script lang="ts">
  import { cn } from '$lib/utils.js';

  let {
    class: className,
    variant = 'default',
    size = 'default',
    ref = $bindable(null),
    href = undefined,
    type = 'button',
    children,
    ...restProps
  }: ButtonProps = $props();
</script>

{#if href}
  <a bind:this={ref} class={cn(buttonVariants({ variant, size }), className)} {href} {...restProps}>
    {@render children?.()}
  </a>
{:else}
  <button bind:this={ref} class={cn(buttonVariants({ variant, size }), className)} {type} {...restProps}>
    {@render children?.()}
  </button>
{/if}
