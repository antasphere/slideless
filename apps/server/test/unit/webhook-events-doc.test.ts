import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DECK_WEBHOOK_EVENTS } from '@slideless/contract';
import {
  renderWebhookEventsDoc,
  slidelessWebhookCatalog,
  WEBHOOK_EVENTS_DOC_PATH
} from '../../scripts/webhookEventsDoc.js';

/**
 * PRDCT-3484: docs/reference/webhook-events.md is generated from the event
 * catalog the instance boots on (the chassis's events plus
 * `DECK_WEBHOOK_EVENTS`). The page is committed, so a catalog change that is
 * not followed by a regeneration would leave the public reference describing
 * events, fields or subjects the instance does not deliver. This renders the
 * page again and compares it with the committed file, byte for byte.
 */
describe('docs/reference/webhook-events.md is the catalog, rendered (PRDCT-3484)', () => {
  it('matches a fresh render: run `pnpm --filter @slideless/server docs:webhook-events` when it does not', async () => {
    const committed = readFileSync(WEBHOOK_EVENTS_DOC_PATH, 'utf8');
    const fresh = await renderWebhookEventsDoc();
    expect(
      committed === fresh,
      'docs/reference/webhook-events.md is out of date with the webhook catalog: run `pnpm --filter @slideless/server docs:webhook-events` and commit the page'
    ).toBe(true);
  });

  it('gives every event type of the catalog its own section', async () => {
    const page = await renderWebhookEventsDoc();
    const types = [...slidelessWebhookCatalog().events.keys()];
    expect(types.length).toBeGreaterThan(DECK_WEBHOOK_EVENTS.length);
    for (const type of types) expect(page, type).toContain(`### \`${type}\``);
  });

  it('renders the same page twice (no clock, no randomness)', async () => {
    expect(await renderWebhookEventsDoc()).toBe(await renderWebhookEventsDoc());
  });
});
