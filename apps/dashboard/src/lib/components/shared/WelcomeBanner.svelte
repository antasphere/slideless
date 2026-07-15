<script lang="ts">
  import { X } from '@lucide/svelte';
  import * as Card from '$lib/components/ui/card/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { api } from '$lib/api';
  import { t } from '$lib/i18n';

  /**
   * SL-6 first-run welcome — the SEAM, not the copy (content is a minimal
   * placeholder; a later content pass owns the words). Rendered by the app
   * shell when `/me.firstRunPending` is true (cloud + sessions only — the
   * field is absent on oss, so this never mounts there).
   *
   * Dismissal is TOOL-LOCAL and retry-safe by design: the local flip is
   * immediate, the server write is best-effort — a lost write means the
   * banner returns next bootstrap (annoying, recoverable), never that a
   * user permanently loses their welcome.
   */
  let { instanceName }: { instanceName: string } = $props();

  /** Placeholder docs target — the product docs home (content pass owns it). */
  const DOCS_URL = 'https://github.com/antasphere/slideless/tree/prod/docs';

  let dismissed = $state(false);

  async function dismiss() {
    dismissed = true;
    try {
      await api.dismissOnboarding();
    } catch {
      // Best-effort: firstRunPending stays true server-side, so the banner
      // reappears on the next bootstrap — the retry-safe semantic (SL-6).
    }
  }
</script>

{#if !dismissed}
  <Card.Root class="relative mb-6 border-primary/20 bg-primary/5">
    <Card.Header class="pr-12">
      <Card.Title class="text-lg">{t('welcome.title', { name: instanceName })}</Card.Title>
      <Card.Description>{t('welcome.body')}</Card.Description>
    </Card.Header>
    <Card.Content class="flex items-center gap-3 pt-0">
      <Button variant="outline" size="sm" href={DOCS_URL} target="_blank" rel="noreferrer">
        {t('welcome.docs')}
      </Button>
      <Button variant="ghost" size="sm" onclick={() => void dismiss()}>
        {t('welcome.dismiss')}
      </Button>
    </Card.Content>
    <button
      type="button"
      class="absolute right-4 top-4 rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
      aria-label={t('welcome.dismiss')}
      onclick={() => void dismiss()}
    >
      <X class="h-4 w-4" />
    </button>
  </Card.Root>
{/if}
