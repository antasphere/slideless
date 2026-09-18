<script lang="ts">
  import type { HTMLInputAttributes, HTMLInputTypeAttribute } from 'svelte/elements';
  import type { WithElementRef } from 'bits-ui';
  import { cn } from '$lib/utils.js';

  type InputType = Exclude<HTMLInputTypeAttribute, 'file'>;

  type Props = WithElementRef<
    Omit<HTMLInputAttributes, 'type'> &
      ({ type: 'file'; files?: FileList } | { type?: InputType; files?: undefined })
  >;

  let {
    ref = $bindable(null),
    value = $bindable(),
    type,
    files = $bindable(),
    class: className,
    ...restProps
  }: Props = $props();
</script>

{#if type === 'file'}
  <input
    bind:this={ref}
    class={cn(
      'border-input placeholder:text-muted-foreground focus-visible:ring-ring flex h-10 w-full rounded-[10px] border bg-[var(--plate-strong)] px-3.5 py-1 text-base transition-[border-color,box-shadow] hover:border-[color-mix(in_oklab,var(--accent)_35%,var(--hairline))] focus-visible:border-[var(--accent)] md:h-9 file:border-0 file:bg-transparent file:text-sm file:font-medium focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--accent-soft)] disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
      className
    )}
    type="file"
    bind:files
    bind:value
    {...restProps}
  />
{:else}
  <input
    bind:this={ref}
    class={cn(
      'border-input placeholder:text-muted-foreground focus-visible:ring-ring flex h-10 w-full rounded-[10px] border bg-[var(--plate-strong)] px-3.5 py-1 text-base transition-[border-color,box-shadow] hover:border-[color-mix(in_oklab,var(--accent)_35%,var(--hairline))] focus-visible:border-[var(--accent)] md:h-9 file:border-0 file:bg-transparent file:text-sm file:font-medium focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--accent-soft)] disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
      className
    )}
    {type}
    bind:value
    {...restProps}
  />
{/if}
