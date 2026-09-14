<script lang="ts">
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { tokenStatus } from '$lib/decks';
  import { formatDate } from '$lib/format';
  import { t } from '$lib/i18n';
  import type { ShareToken } from '@slideless/contract';

  /** The link's status as a pill, its expiry (or the absence of one) behind the hover. */
  interface Props {
    token: ShareToken;
  }

  let { token }: Props = $props();

  const status = $derived(tokenStatus(token));
  const label = $derived(
    status === 'active'
      ? t('tokens.statusActive')
      : status === 'revoked'
        ? t('tokens.statusRevoked')
        : t('tokens.statusExpired')
  );
  const hint = $derived(
    token.expiresAt ? t('tokens.expiresOn', { date: formatDate(token.expiresAt) }) : t('tokens.expiryNever')
  );
</script>

<Badge variant={status === 'active' ? 'outline' : 'destructive'} title={hint} data-testid="link-status">
  {label}
</Badge>
