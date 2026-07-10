<script lang="ts" module>
  import { type VariantProps, tv } from 'tailwind-variants';
  export const badgeVariants = tv({
    base: 'focus:ring-ring inline-flex select-none items-center rounded-md border text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2',
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/80 border-transparent shadow',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80 border-transparent',
        destructive:
          'bg-destructive text-destructive-foreground hover:bg-destructive/80 border-transparent shadow',
        outline: 'text-foreground',
        version:
          'border-purple-500/20 bg-purple-500/10 text-purple-600 hover:border-purple-500/40 hover:bg-purple-500/20 hover:text-purple-700 dark:text-purple-400 dark:hover:border-purple-400/40 dark:hover:bg-purple-400/20 dark:hover:text-purple-300 dark:border-purple-400/20 dark:bg-purple-400/10 font-mono',
        old: 'border-orange-500/20 bg-orange-500/10 text-orange-600 hover:border-orange-500/40 hover:bg-orange-500/20 hover:text-orange-700 dark:text-orange-400 dark:hover:border-orange-400/40 dark:hover:bg-orange-400/20 dark:hover:text-orange-300 dark:border-orange-400/20 dark:bg-orange-400/10 font-mono',
        latest:
          'border-green-500/20 bg-green-500/10 text-green-600 hover:border-green-500/40 hover:bg-green-500/20 hover:text-green-700 dark:text-green-400 dark:hover:border-green-400/40 dark:hover:bg-green-400/20 dark:hover:text-green-300 dark:border-green-400/20 dark:bg-green-400/10 font-mono',
        accepted:
          'border-blue-500/20 bg-blue-500/10 text-blue-600 hover:border-blue-500/40 hover:bg-blue-500/20 hover:text-blue-700 dark:text-blue-400 dark:hover:border-blue-400/40 dark:hover:bg-blue-400/20 dark:hover:text-blue-300 dark:border-blue-400/20 dark:bg-blue-400/10 font-mono',
        inactive:
          'border-slate-500/20 bg-slate-500/10 text-slate-600 hover:border-slate-500/40 hover:bg-slate-500/20 hover:text-slate-700 dark:text-slate-400 dark:hover:border-slate-400/40 dark:hover:bg-slate-400/20 dark:hover:text-slate-300 dark:border-slate-400/20 dark:bg-slate-400/10 font-mono'
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
