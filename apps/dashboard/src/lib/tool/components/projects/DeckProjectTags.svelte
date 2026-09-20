<script lang="ts">
  /* The projects a deck sits in, as small tags on its card or its row
     (PRDCT-2584). Only the projects of the payload, which are the ones the
     reader can read.

     SECURITY: a project's name is USER-AUTHORED; Tag renders its label as
     text, never as markup. */
  import { Tag } from '$lib/components/ui/tag';
  import Folder from '@lucide/svelte/icons/folder';
  import { deckProjects, type DeckWithProjects } from '$lib/tool/projects-client';
  import { t } from '$lib/i18n';

  interface Props {
    deck: DeckWithProjects;
    /** A project left out: the one whose page the deck is already shown on. */
    except?: string;
  }

  let { deck, except }: Props = $props();

  const refs = $derived(deckProjects.named(deck).filter((p) => p.id !== except));
</script>

{#if refs.length}
  <span class="inline-flex min-w-0 flex-wrap gap-1.5" data-testid="deck-projects">
    {#each refs as ref (ref.id)}
      <Tag
        label={ref.name}
        tone="slate"
        icon={Folder}
        detail={ref.isBrand ? t('deckProjects.tagBrand') : undefined}
      />
    {/each}
  </span>
{/if}
