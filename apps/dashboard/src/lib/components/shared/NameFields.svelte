<script lang="ts">
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { capitalizeNamePart } from '$lib/person-name';
  import { t } from '$lib/i18n';

  /* First name and last name, side by side, wherever a person creates an
     account (setup, a workspace invitation, a deck collaborator claim). View
     only: the caller sends `joinPersonName(first, last)` as the one `name`
     the API has always taken. Leaving a field raises the first letter of
     each part of what was typed, so a name entered in lowercase is stored
     the way it is written. */
  interface Props {
    first: string;
    last: string;
    /** Prefixes the two input ids, so a page's labels stay unique. */
    idPrefix: string;
  }

  let { first = $bindable(), last = $bindable(), idPrefix }: Props = $props();
</script>

<div class="grid grid-cols-1 gap-4 min-[420px]:grid-cols-2 min-[420px]:gap-3">
  <div class="space-y-2">
    <Label for="{idPrefix}-first-name">{t('name.first')}</Label>
    <Input
      id="{idPrefix}-first-name"
      autocomplete="given-name"
      autocapitalize="words"
      bind:value={first}
      onblur={() => (first = capitalizeNamePart(first))}
      required
    />
  </div>
  <div class="space-y-2">
    <Label for="{idPrefix}-last-name">{t('name.last')}</Label>
    <Input
      id="{idPrefix}-last-name"
      autocomplete="family-name"
      autocapitalize="words"
      bind:value={last}
      onblur={() => (last = capitalizeNamePart(last))}
      required
    />
  </div>
</div>
