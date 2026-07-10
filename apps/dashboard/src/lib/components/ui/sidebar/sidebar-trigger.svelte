<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import { cn } from '$lib/utils.js';
  import PanelLeft from '@lucide/svelte/icons/panel-left';
  import type { ComponentProps } from 'svelte';
  import { t } from '$lib/i18n';
  import { useSidebar } from './context.svelte.js';

  let {
    ref = $bindable(null),
    class: className,
    onclick,
    ...restProps
  }: ComponentProps<typeof Button> & {
    onclick?: (e: MouseEvent) => void;
  } = $props();

  const sidebar = useSidebar();
</script>

<Button
  type="button"
  onclick={(e) => {
    onclick?.(e);
    sidebar.toggle();
  }}
  data-sidebar="trigger"
  variant="ghost"
  size="icon"
  class={cn('relative z-[60] h-8 w-8', className)}
  {...restProps}
>
  <PanelLeft />
  <span class="sr-only">{t('nav.toggleSidebar')}</span>
</Button>
