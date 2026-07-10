<script lang="ts">
  import InfoTooltip from '$lib/components/ui/InfoTooltip.svelte';
  import { Label } from '$lib/components/ui/label';
  import type { Snippet } from 'svelte';

  interface Props {
    label: string;
    id: string;
    tooltip?: string;
    required?: boolean;
    preDescription?: string;
    postDescription?: string;
    error?: string;
    action?: Snippet;
    children: Snippet;
  }

  let {
    label,
    id,
    tooltip,
    required = false,
    preDescription,
    postDescription,
    error,
    action,
    children
  }: Props = $props();
</script>

<div class="space-y-2">
  <!-- Label with optional tooltip and action -->
  <div class="flex items-center justify-between">
    <div class="flex items-center gap-2">
      <Label for={id}>
        {label}
        {#if required}
          <span class="text-destructive">*</span>
        {/if}
      </Label>
      {#if tooltip}
        <InfoTooltip content={tooltip} />
      {/if}
    </div>
    {#if action}
      {@render action()}
    {/if}
  </div>

  <!-- Pre-description (explanatory text) -->
  {#if preDescription}
    <p class="text-muted-foreground text-xs">
      {preDescription}
    </p>
  {/if}

  <!-- Input field slot -->
  {@render children()}

  <!-- Error message -->
  {#if error}
    <p class="text-destructive text-sm">{error}</p>
  {/if}

  <!-- Post-description (validation hints) -->
  {#if postDescription}
    <p class="text-muted-foreground pl-0.5 text-xs">
      {postDescription}
    </p>
  {/if}
</div>
