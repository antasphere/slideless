<script lang="ts">
  /* The two fields a project is made of, shared by the create and the edit
     dialogs. The lengths are the API's own limits. */
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { Textarea } from '$lib/components/ui/textarea/index.js';
  import { t } from '$lib/i18n';

  interface Props {
    name: string;
    description: string;
    /** Two dialogs may be in the page at once: each names its fields apart. */
    idPrefix: string;
  }
  let { name = $bindable(), description = $bindable(), idPrefix }: Props = $props();
</script>

<div class="space-y-2">
  <Label for="{idPrefix}-name">{t('projects.nameLabel')}</Label>
  <Input
    id="{idPrefix}-name"
    bind:value={name}
    placeholder={t('projects.namePlaceholder')}
    maxlength={120}
    autocomplete="off"
    required
  />
</div>
<div class="space-y-2">
  <Label for="{idPrefix}-description">{t('projects.descriptionLabel')}</Label>
  <Textarea
    id="{idPrefix}-description"
    bind:value={description}
    placeholder={t('projects.descriptionPlaceholder')}
    maxlength={500}
    rows={3}
  />
  <p class="text-xs text-muted-foreground">{t('projects.descriptionHint')}</p>
</div>
