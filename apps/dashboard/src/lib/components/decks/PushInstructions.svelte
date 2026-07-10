<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import Copy from '@lucide/svelte/icons/copy';
  import { copyText } from '$lib/clipboard';
  import { t } from '$lib/i18n';

  /**
   * How decks get in: there is deliberately NO upload form — decks are
   * pushed by the slideless CLI or an agent. This block is the "new deck"
   * affordance (empty state + New deck dialog).
   */

  // SPA (ssr=false): window is always available at render time.
  const origin = window.location.origin;
  const loginCommand = `slideless login --api-url ${origin} --api-key slk_…`;
  const pushCommand = 'slideless push ./my-deck';
</script>

<div class="space-y-4">
  <p class="text-sm text-muted-foreground">{t('decks.pushDescription')}</p>
  <div class="space-y-2">
    <p class="text-sm">{t('decks.pushConnect')}</p>
    <div class="flex items-center gap-2">
      <code class="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-md bg-muted px-3 py-2 font-mono text-xs">
        {loginCommand}
      </code>
      <Button
        size="icon"
        variant="outline"
        class="shrink-0"
        aria-label={t('decks.copyCommandAria')}
        onclick={() => void copyText(loginCommand, t('decks.commandCopied'))}
      >
        <Copy class="h-4 w-4" />
      </Button>
    </div>
  </div>
  <div class="space-y-2">
    <p class="text-sm">{t('decks.pushPush')}</p>
    <div class="flex items-center gap-2">
      <code class="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-md bg-muted px-3 py-2 font-mono text-xs">
        {pushCommand}
      </code>
      <Button
        size="icon"
        variant="outline"
        class="shrink-0"
        aria-label={t('decks.copyCommandAria')}
        onclick={() => void copyText(pushCommand, t('decks.commandCopied'))}
      >
        <Copy class="h-4 w-4" />
      </Button>
    </div>
  </div>
  <p class="text-xs text-muted-foreground">{t('decks.pushDocs')}</p>
</div>
