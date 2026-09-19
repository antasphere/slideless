<script lang="ts">
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { t } from '$lib/i18n';

  /**
   * What the link opens, as a tag (PRDCT-2308): `latest` in the ok wash when
   * the link follows every push, `v3` in the accent wash when it is pinned.
   */
  interface Props {
    pinnedVersion: number | null;
  }

  let { pinnedVersion }: Props = $props();
</script>

{#if pinnedVersion === null}
  <Badge variant="latest" data-testid="link-version" data-mode="latest">{t('tokens.tagLatest')}</Badge>
{:else}
  <Badge variant="version" data-testid="link-version" data-mode="pinned">v{pinnedVersion}</Badge>
{/if}
