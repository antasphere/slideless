<script lang="ts">
  import { CodeBlock } from '$lib/components/ui/code-block/index.js';
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
    <CodeBlock
      code={loginCommand}
      language="shell"
      copyLabel={t('decks.copyCommandAria')}
      copiedMessage={t('decks.commandCopied')}
    />
  </div>
  <div class="space-y-2">
    <p class="text-sm">{t('decks.pushPush')}</p>
    <CodeBlock
      code={pushCommand}
      language="shell"
      copyLabel={t('decks.copyCommandAria')}
      copiedMessage={t('decks.commandCopied')}
    />
  </div>
  <p class="text-xs text-muted-foreground">{t('decks.pushDocs')}</p>
</div>
