<script lang="ts">
  /* A project's line in the list: its name, and under it what it is for.
     SECURITY: both are USER-AUTHORED and render through text interpolation,
     always escaped. Never {@html}. */
  interface Props {
    name: string;
    description: string | null;
  }
  let { name, description }: Props = $props();
</script>

<span class="block truncate">{name}</span>
{#if description}
  <span class="block truncate text-xs font-normal text-muted-foreground">{description}</span>
{/if}
