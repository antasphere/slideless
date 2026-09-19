<script lang="ts">
  import { CodeBlock } from '$lib/components/ui/code-block/index.js';
  import { t } from '$lib/i18n';
  import type { ReferenceType } from '@slideless/contract';

  /**
   * How a reference gets in (PRDCT-2421): there is deliberately NO upload
   * form. A brand or a template is a deck, scaffolded, pushed and published
   * from the command line (`slideless brand …`, `slideless template …`, the
   * two shortcut families of `slideless reference`). This block is the
   * "Add a brand" affordance: the empty state and the add dialog.
   */
  interface Props {
    type: ReferenceType;
  }

  let { type }: Props = $props();

  const folder = $derived(type === 'brand' ? './my-brand' : './my-template');
  const scaffold = $derived(`slideless ${type} new ${folder}`);
  const push = $derived(`slideless ${type} push ${folder}`);
  const publish = $derived(`slideless ${type} publish "${type === 'brand' ? 'My brand' : 'My template'}"`);
</script>

<div class="space-y-4">
  <p class="text-sm text-muted-foreground">
    {t(type === 'brand' ? 'refs.pushDescriptionBrand' : 'refs.pushDescriptionTemplate')}
  </p>
  <div class="space-y-2">
    <p class="text-sm">{t('refs.pushScaffold')}</p>
    <CodeBlock
      code={scaffold}
      language="shell"
      copyLabel={t('decks.copyCommandAria')}
      copiedMessage={t('decks.commandCopied')}
    />
  </div>
  <div class="space-y-2">
    <p class="text-sm">{t('refs.pushPush')}</p>
    <CodeBlock
      code={push}
      language="shell"
      copyLabel={t('decks.copyCommandAria')}
      copiedMessage={t('decks.commandCopied')}
    />
  </div>
  <div class="space-y-2">
    <p class="text-sm">{t('refs.pushPublish')}</p>
    <CodeBlock
      code={publish}
      language="shell"
      copyLabel={t('decks.copyCommandAria')}
      copiedMessage={t('decks.commandCopied')}
    />
  </div>
  <p class="text-xs text-muted-foreground">{t('refs.pushLogin')}</p>
</div>
