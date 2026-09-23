import { toast } from 'svelte-sonner';
import { errorMessage, PlatformApiError } from '$lib/api';
import { getLocale, t } from '$lib/i18n';

/**
 * The billing rail's two refusals, as the dashboard shows them (the billing
 * rail spec §7 step 4, PRDCT-2664): two codes, two cards, distinct.
 *
 * - 403 `plan_required` + `details.upgradeUrl` → the UPGRADE card: the plan
 *   does not allow the action; the link is the hub's organization page.
 * - 402 `entitlement_denied` + `details.topUpUrl` → the TOP-UP card: the plan
 *   allows it but the organization lacks the credits.
 *
 * A self-hosted instance still answers `entitlement_denied` as 413 WITHOUT
 * details (the operator's cap): that is no card, the caller's own branch
 * handles it. The decision is on the details, never on the edition.
 */
export interface RefusalCard {
  kind: 'upgrade' | 'top-up';
  title: string;
  description: string;
  /** The button's label and its link; null when no page can help (no plan allows the action). */
  action: string | null;
  url: string | null;
}

function detailsOf(e: PlatformApiError): Record<string, unknown> | null {
  return typeof e.details === 'object' && e.details !== null ? (e.details as Record<string, unknown>) : null;
}

function formatCount(value: unknown): string {
  return typeof value === 'number' ? value.toLocaleString(getLocale()) : String(value ?? '?');
}

export function refusalCard(e: unknown): RefusalCard | null {
  if (!(e instanceof PlatformApiError)) return null;
  const details = detailsOf(e);
  if (!details) return null;
  if (e.code === 'plan_required' && typeof details.upgradeUrl === 'string') {
    if (typeof details.requiredPlan !== 'string') {
      // No tier allows it (today's cloud, where the paid cap equals the free
      // one): a button to a plan page would send the person to buy what will
      // not help (verifier round 1), so the card says so and offers nothing.
      return {
        kind: 'upgrade',
        title: t('billing.noPlanTitle'),
        description: t('billing.upgradeDescriptionNoPlan'),
        action: null,
        url: null
      };
    }
    return {
      kind: 'upgrade',
      title: t('billing.upgradeTitle'),
      description: t('billing.upgradeDescription', { requiredPlan: details.requiredPlan }),
      action: t('billing.upgradeAction'),
      url: details.upgradeUrl
    };
  }
  if (e.code === 'entitlement_denied' && typeof details.topUpUrl === 'string') {
    return {
      kind: 'top-up',
      title: t('billing.topUpTitle'),
      description: t('billing.topUpDescription', {
        credits: formatCount(details.credits),
        balance: formatCount(details.balance)
      }),
      action: t('billing.topUpAction'),
      url: details.topUpUrl
    };
  }
  return null;
}

/**
 * The toast of a failed API call: a billing refusal becomes its card (title,
 * description, and the action that opens the hub's page in a new tab);
 * anything else is `errorMessage`'s sentence, as before.
 */
export function toastApiError(e: unknown, fallback: string): void {
  const card = refusalCard(e);
  if (card) {
    const { action, url } = card;
    toast.error(card.title, {
      description: card.description,
      ...(action && url
        ? { action: { label: action, onClick: () => window.open(url, '_blank', 'noopener,noreferrer') } }
        : {})
    });
    return;
  }
  toast.error(errorMessage(e, fallback));
}
