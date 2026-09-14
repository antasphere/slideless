<script lang="ts">
  import Lock from '@lucide/svelte/icons/lock';
  import { t } from '$lib/i18n';

  /**
   * The recipient's name on ONE line, cut with an ellipsis, the whole name
   * on hover (PRDCT-2308); a lock beside it when the link asks for a
   * password. SECURITY: the label is USER-SUPPLIED text — escaped {}
   * interpolation only, in the text and in the title attribute alike.
   */
  interface Props {
    name: string;
    hasPassword: boolean;
  }

  let { name, hasPassword }: Props = $props();
</script>

<span class="flex min-w-0 items-center gap-1.5">
  {#if hasPassword}
    <span class="inline-flex shrink-0" title={t('tokens.passwordProtected')} data-testid="link-password">
      <Lock class="h-3.5 w-3.5 text-muted-foreground" />
      <span class="sr-only">{t('tokens.passwordProtected')}</span>
    </span>
  {/if}
  <span class="block min-w-0 truncate" title={name} data-testid="link-name">{name}</span>
</span>
