<script lang="ts">
  import type { Component } from 'svelte';

  let {
    icon,
    size = 'md',
    iconColors = {
      primary: 'rgba(16, 185, 129, 0.2)',
      secondary: 'rgba(59, 130, 246, 0.2)'
    }
  }: {
    icon: Component;
    size?: 'sm' | 'md' | 'lg';
    iconColors?: {
      primary: string;
      secondary: string;
    };
  } = $props();

  let Icon = $derived(icon);

  // Size variants
  const sizeClasses: Record<string, string> = {
    sm: 'h-10 w-10',
    md: 'h-12 w-12',
    lg: 'h-16 w-16'
  };

  const iconSizeClasses: Record<string, string> = {
    sm: 'h-5 w-5',
    md: 'h-6 w-6',
    lg: 'h-8 w-8'
  };

  // Extract base color and create subtle border/shadow variants
  let borderColor = $derived(iconColors.primary.replace(/[\d.]+\)$/, '0.07)'));
  let shadowPrimary = $derived(iconColors.primary.replace(/[\d.]+\)$/, '0.18)'));
  let shadowSecondary = $derived(iconColors.secondary.replace(/[\d.]+\)$/, '0.28)'));
</script>

<div class="relative">
  <!-- Aurora background -->
  <div
    class="absolute inset-0 rounded-xl backdrop-blur-sm"
    style="background:
			radial-gradient(circle at 20% 80%, {iconColors.primary} 0%, transparent 50%),
			radial-gradient(circle at 80% 20%, {iconColors.secondary} 0%, transparent 50%),
			url('/assets/noise.svg');
		filter: contrast(120%) brightness(110%);"
  ></div>
  <!-- Glass morphism overlay -->
  <div
    class="absolute inset-0 rounded-xl border bg-white/40 backdrop-blur-md dark:bg-white/10"
    style="border-color: {borderColor}; box-shadow: 0 1px 3px 0 {shadowPrimary}, 0 1px 2px -1px {shadowSecondary};"
  ></div>
  <!-- Icon container -->
  <div class="relative flex {sizeClasses[size]} items-center justify-center rounded-xl">
    <Icon class="{iconSizeClasses[size]} text-slate-600 drop-shadow-sm dark:text-slate-300" />
  </div>
</div>
