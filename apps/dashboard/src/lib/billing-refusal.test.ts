import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlatformApiError } from '@slideless/sdk';
import { en } from '$lib/i18n';

const toastMock = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('svelte-sonner', () => ({ toast: toastMock }));

import { refusalCard, toastApiError } from './billing-refusal';

/**
 * The billing rail's two refusals on the dashboard (PRDCT-2664): two codes,
 * two cards. A 403 plan_required is the upgrade card, a 402
 * entitlement_denied the top-up card; the self-hosted 413 without details is
 * no card at all.
 */

const UPGRADE_URL = 'https://account.antasphere.com/orgs/acme';
const TOP_UP_URL = 'https://account.antasphere.com/orgs/acme/billing';

const planRequired = (requiredPlan: string | null) =>
  new PlatformApiError(403, 'plan_required', 'This needs the pro plan', {
    key: 'files.maxBytes',
    plan: 'free',
    requiredPlan,
    upgradeUrl: UPGRADE_URL
  });

const creditsDenied = () =>
  new PlatformApiError(402, 'entitlement_denied', 'Not enough credits', {
    credits: 1500,
    balance: 20,
    topUpUrl: TOP_UP_URL
  });

describe('refusalCard', () => {
  it('403 plan_required: the upgrade card, naming the plan that allows it', () => {
    const card = refusalCard(planRequired('pro'));
    expect(card).toEqual({
      kind: 'upgrade',
      title: en['billing.upgradeTitle'],
      description: en['billing.upgradeDescription'].replace('{requiredPlan}', 'pro'),
      action: en['billing.upgradeAction'],
      url: UPGRADE_URL
    });
    expect(card?.description).toContain('pro');
  });

  it('403 plan_required with no plan that allows it: the no-plan card, no button to a page that cannot help', () => {
    const card = refusalCard(planRequired(null));
    expect(card).toEqual({
      kind: 'upgrade',
      title: en['billing.noPlanTitle'],
      description: en['billing.upgradeDescriptionNoPlan'],
      action: null,
      url: null
    });
    expect(card?.title).not.toBe(en['billing.upgradeTitle']);
  });

  it('402 entitlement_denied: the top-up card, with the price, the balance and the link', () => {
    const card = refusalCard(creditsDenied());
    expect(card?.kind).toBe('top-up');
    expect(card?.title).toBe(en['billing.topUpTitle']);
    expect(card?.action).toBe(en['billing.topUpAction']);
    expect(card?.url).toBe(TOP_UP_URL);
    expect(card?.description).toContain((1500).toLocaleString('en'));
    expect(card?.description).toContain('20');
  });

  it('the two cards are distinct', () => {
    expect(refusalCard(planRequired('pro'))?.title).not.toBe(refusalCard(creditsDenied())?.title);
  });

  it('413 entitlement_denied without details (the self-hosted cap) is no card', () => {
    expect(refusalCard(new PlatformApiError(413, 'entitlement_denied', 'File exceeds 100 MB'))).toBeNull();
  });

  it('a 404 is no card', () => {
    expect(refusalCard(new PlatformApiError(404, 'not_found', 'Not found'))).toBeNull();
  });

  it('a plain Error is no card', () => {
    expect(refusalCard(new Error('Failed to fetch'))).toBeNull();
  });
});

describe('toastApiError', () => {
  beforeEach(() => {
    toastMock.error.mockClear();
  });

  it('a card is a toast with its description and an action that opens the url in a new tab', () => {
    const open = vi.fn();
    vi.stubGlobal('window', { open });
    try {
      toastApiError(creditsDenied(), 'Upload failed');
      expect(toastMock.error).toHaveBeenCalledTimes(1);
      const [title, options] = toastMock.error.mock.calls[0] as [
        string,
        { description: string; action: { label: string; onClick: () => void } }
      ];
      expect(title).toBe(en['billing.topUpTitle']);
      expect(options.action.label).toBe(en['billing.topUpAction']);
      options.action.onClick();
      expect(open).toHaveBeenCalledWith(TOP_UP_URL, '_blank', 'noopener,noreferrer');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('the no-plan card is a toast with its sentence and NO action', () => {
    toastApiError(planRequired(null), 'Upload failed');
    expect(toastMock.error).toHaveBeenCalledTimes(1);
    const [title, options] = toastMock.error.mock.calls[0] as [
      string,
      { description: string; action?: unknown }
    ];
    expect(title).toBe(en['billing.noPlanTitle']);
    expect(options.description).toBe(en['billing.upgradeDescriptionNoPlan']);
    expect(options.action).toBeUndefined();
  });

  it('anything else is the error message, as before', () => {
    toastApiError(new PlatformApiError(404, 'not_found', 'Deck not found'), 'Upload failed');
    expect(toastMock.error).toHaveBeenCalledWith('Deck not found');
  });
});
