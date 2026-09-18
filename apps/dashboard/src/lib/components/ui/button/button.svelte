<script lang="ts" module>
  import type { WithElementRef } from 'bits-ui';
  import type { HTMLAnchorAttributes, HTMLButtonAttributes } from 'svelte/elements';
  import { type VariantProps, tv } from 'tailwind-variants';

  export const buttonVariants = tv({
    base: 'focus-visible:ring-ring inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-btn text-sm font-medium transition-[color,background-color,filter,transform] focus-visible:outline-none focus-visible:ring-1 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
    variants: {
      variant: {
        // Filled controls carry the brand material: grain + falling light
        // over the accent; hover moves only the fill (brightness).
        default: 'material bg-[var(--accent)] text-[var(--accent-ink)] hover:brightness-[0.94]',
        // The accent is a clay (dawn) and danger IS the ember: two filled
        // clays side by side read as one button. Danger is therefore a wash
        // at rest and only fills under the hand.
        destructive:
          'bg-[var(--danger-soft)] text-[var(--danger)] border border-[color-mix(in_oklab,var(--danger)_35%,transparent)] hover:bg-[var(--danger)] hover:text-[var(--accent-ink)]',
        outline:
          'bg-transparent border border-border hover:bg-[var(--ground-3)] hover:text-foreground shadow-sm',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-[var(--ground-3)]',
        ghost: 'hover:bg-[var(--ground-3)] hover:text-foreground',
        link: 'text-primary underline-offset-4 hover:underline'
      },
      size: {
        default: 'h-9 px-4 py-2',
        xs: 'h-8 px-2 text-xs',
        sm: 'h-8 px-3 text-xs',
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
