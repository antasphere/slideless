// The billing campaign (PRDCT-2718): loop, the whole loop across the two products.
// A new organization signs up through Slideless and holds the sign-up grant.
// It consumes in Slideless until the hub refuses, buys a pack in the hub, and the
// same action goes through. Then the same loop runs on the viewer's door: a form
// response through a share link, paid by the deck's owner.
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { CampaignError, expectStatus, sleep, waitFor } from '../lib/http.mjs';
import { CARDS } from '../lib/checkout.mjs';

export const group = 'loop';

const MIB = 1_048_576;
const BILLING_EMAIL = 'campaign-loop@drill.test';
const FORM_PAGE =
  '<!doctype html><html><head><meta charset="utf-8"><title>Campaign loop intake</title></head><body>' +
  '<h1>Campaign loop intake</h1>' +
  '<form data-slideless-form="intake"><input name="who"><button type="submit">Send</button></form>' +
  '</body></html>\n';
const PLAIN_PAGE =
  '<!doctype html><html><head><meta charset="utf-8"><title>Campaign loop deck</title></head><body>' +
  '<h1>Campaign loop deck</h1><p>One page.</p></body></html>\n';

/** The loop's state, kept on ctx.shared.loop; a later scenario refuses to run without it. */
function state(ctx, ...keys) {
  const s = ctx.shared.loop;
  if (!s) throw new CampaignError('the loop state is missing: the sign-up scenario did not run or failed', {});
  for (const k of keys) {
    if (s[k] === undefined || s[k] === null) throw new CampaignError(`the loop state has no ${k}: an earlier loop scenario did not run or failed`, { has: Object.keys(s) });
  }
  return s;
}

/** Write a one-page deck folder under the scratch folder; answers the folder. */
function deckFolder(ctx, name, html) {
  const dir = path.join(ctx.config.out, 'decks', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'index.html'), html);
  return dir;
}

/** The ids of every ledger entry of the organization right now. */
async function ledgerIds(ctx, org) {
  return new Set((await ctx.hub.ledger(org)).map((e) => e.id));
}

/** The usage_events row of one event id on the hub: `{ id, actionKey, userId, via, credits }`, or null. */
async function usageRow(ctx, eventId) {
  const out = await ctx.hub.sql(
    `SELECT id || '|' || action_key || '|' || coalesce(user_id, '') || '|' || via || '|' || coalesce(credits::text, '') FROM usage_events WHERE id = '${eventId}'`
  );
  if (!out) return null;
  const [id, actionKey, userId, via, credits] = out.split('|');
  return { id, actionKey, userId, via, credits: credits === '' ? null : Number(credits) };
}

/**
 * Wait until `count` debit entries that are not in `known` are on the ledger.
 * Answers them, each with its usage_events row, oldest first. Throws when they
 * do not all arrive within the timeout.
 */
async function newDebits(ctx, org, known, count, timeoutMs = 60_000) {
  const found = await waitFor(
    async () => {
      const fresh = (await ctx.hub.ledger(org, 'debit')).filter((e) => !known.has(e.id));
      return fresh.length >= count ? fresh : null;
    },
    { every: 1500, timeoutMs }
  );
  if (!found) {
    const fresh = (await ctx.hub.ledger(org, 'debit')).filter((e) => !known.has(e.id));
    throw new CampaignError(`expected ${count} new debit entries on the ledger, found ${fresh.length}`, {
      org,
      fresh: fresh.map((e) => ({ id: e.id, amount: e.amount, sourceRef: e.sourceRef }))
    });
  }
  const out = [];
  for (const e of found.slice().reverse()) out.push({ id: e.id, amount: e.amount, balanceAfter: e.balanceAfter, eventId: e.sourceRef, usage: await usageRow(ctx, e.sourceRef) });
  return out;
}

/** The share secret of a mint answer: `shareToken.secret`, else the path segment after `/v/` in `shareToken.url`. Never logged. */
function secretOf(minted) {
  const t = minted?.shareToken ?? {};
  if (typeof t.secret === 'string' && t.secret) return t.secret;
  if (typeof t.url === 'string') {
    const m = t.url.match(/\/v\/([^/?#]+)/);
    if (m) return m[1];
  }
  return null;
}

/** The payment intent id of a paid Checkout session (the purchase's sourceRef), polled briefly. */
async function intentOfSession(ctx, sessionId) {
  return waitFor(
    async () => {
      const s = await ctx.stripe.checkoutSession(sessionId);
      const pi = s.payment_intent;
      return typeof pi === 'string' ? pi : pi?.id ?? null;
    },
    { every: 1500, timeoutMs: 30_000 }
  );
}

/** Buy the 20,000 pack through hosted Checkout with the visa card; answers the session, the intent and the purchase entry. */
async function buyPack(ctx, org, label) {
  const res = await ctx.hub.checkout(org, { pack: 20000 });
  expectStatus(res, 200, 'POST /billing/checkout { pack: 20000 }');
  const { url, sessionId } = res.json ?? {};
  if (!url || !sessionId) throw new CampaignError('the checkout answer carries no url or session id', { body: res.json });
  const paid = await ctx.payCheckout(url, { card: CARDS.visa, expect: 'paid', mode: 'payment', label });
  if (paid.outcome !== 'paid') throw new CampaignError('the Checkout page was not paid', { sessionId, outcome: paid.outcome, text: paid.text });
  const intentId = await intentOfSession(ctx, sessionId);
  if (!intentId) throw new CampaignError('the paid Checkout session carries no payment intent', { sessionId });
  const entry = await ctx.hub.waitLedger(org, { kind: 'purchase', amount: 20000, sourceRef: intentId });
  if (!entry) {
    throw new CampaignError('no purchase of 20,000 credits for the payment intent on the ledger within 90 s', {
      sessionId,
      intentId,
      purchases: (await ctx.hub.ledger(org, 'purchase')).map((e) => ({ id: e.id, amount: e.amount, sourceRef: e.sourceRef })),
      relay: ctx.relay.ofObject(intentId).map((r) => ({ type: r.type, outcome: r.outcome, status: r.status }))
    });
  }
  const entries = await ctx.hub.entriesOf(org, intentId);
  if (entries.length !== 1) throw new CampaignError('the payment intent wrote more than one ledger entry', { intentId, entries });
  const customerId = await ctx.hub.customerOf(org);
  if (customerId) await ctx.stripe.tagCustomer(customerId);
  return { sessionId, intentId, entry, customerId, returnedTo: paid.url };
}

/** Retry an action until it answers 201 or the deadline passes; answers the last response and the attempts. */
async function until201(send, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  const statuses = [];
  for (;;) {
    const res = await send();
    statuses.push(res.status);
    if (res.status === 201 || Date.now() > deadline) return { res, statuses };
    await sleep(2000);
  }
}

export const scenarios = [
  {
    name: 'a new organization signs up through Slideless and holds the sign-up grant',
    path: 'Slideless + hub',
    async run(ctx) {
      const { workspaceId, org } = await ctx.sl.createWorkspace('Campaign loop');
      if (!workspaceId || !org) throw new CampaignError('the new workspace does not project a hub organization', { workspaceId, org });
      ctx.log(`loop: workspace ${workspaceId}, organization ${org}`);
      const settings = (await ctx.hub.settings()).settings;
      const account = await ctx.hub.account(org);
      const facts = {
        balance: account.balance,
        signupCredits: settings.signupCredits,
        plan: account.plan,
        currency: account.currency,
        currencyLocked: account.currencyLocked
      };
      if (account.balance !== settings.signupCredits) throw new CampaignError('the new account does not hold the sign-up grant', facts);
      if (settings.signupCredits !== 5000) throw new CampaignError('the sign-up grant is not 5,000 credits in the settings', facts);
      if (account.plan !== 'free') throw new CampaignError('the new account is not on the free plan', facts);
      if (account.currency !== 'EUR') throw new CampaignError('the new account is not in EUR', facts);
      if (account.currencyLocked !== false) throw new CampaignError('the new account currency is locked before any purchase', facts);
      const ledger = await ctx.hub.ledger(org);
      const signups = ledger.filter((e) => e.kind === 'signup');
      if (signups.length !== 1 || signups[0].amount !== settings.signupCredits) {
        throw new CampaignError('the ledger does not carry exactly one signup entry of the grant', { ...facts, ledger: ledger.map((e) => ({ kind: e.kind, amount: e.amount })) });
      }
      const me = await ctx.sl.me();
      const listed = (me.workspaces ?? []).find((w) => w.id === workspaceId);
      if (!listed) throw new CampaignError('GET /me does not list the new workspace', { workspaceId, listed: (me.workspaces ?? []).map((w) => w.id) });
      if (listed.hubOrigin !== true || listed.role !== 'owner') {
        throw new CampaignError('the new workspace is not listed as hub-origin with the owner role', { workspaceId, hubOrigin: listed.hubOrigin, role: listed.role });
      }
      const key = await ctx.sl.createKey(workspaceId, 'campaign loop key');
      if (typeof key !== 'string' || !key.startsWith('slk_')) throw new CampaignError('the key mint did not answer an slk_ key', { prefix: String(key).slice(0, 4) });
      const patched = await ctx.hub.patchAccount(org, { billingEmail: BILLING_EMAIL });
      if (patched.billingEmail !== undefined && patched.billingEmail !== BILLING_EMAIL) {
        throw new CampaignError('the PATCH did not keep the billing email', { billingEmail: patched.billingEmail });
      }
      const accountId = account.accountId ?? (await ctx.hub.accountIdOf(org));
      ctx.shared.loop = { org, workspaceId, accountId, key, userId: ctx.hub.user.id };
      return {
        org,
        workspaceId,
        accountId,
        balance: account.balance,
        signupCredits: settings.signupCredits,
        plan: account.plan,
        currency: account.currency,
        currencyLocked: account.currencyLocked,
        signupEntryId: signups[0].id,
        hubOrigin: listed.hubOrigin,
        role: listed.role,
        keyMinted: true,
        billingEmail: BILLING_EMAIL
      };
    }
  },
  {
    name: 'it consumes in Slideless until refused',
    path: 'Slideless + hub',
    async run(ctx) {
      const s = state(ctx, 'org', 'workspaceId', 'accountId', 'key');
      const { org, workspaceId: ws, accountId, key } = s;
      const start = await ctx.hub.account(org);

      // Two real actions first: a new deck (its commit) and its page (an upload).
      const known = await ledgerIds(ctx, org);
      const folder = deckFolder(ctx, 'loop', PLAIN_PAGE);
      const pushed = await ctx.sl.push(folder, { key, ws, title: 'Campaign loop deck' });
      const deckId = pushed?.presentation?.id;
      if (!deckId) throw new CampaignError('the CLI push answered no presentation id', { keys: Object.keys(pushed ?? {}) });
      await ctx.sl.waitUsageDrained();
      const pushDebits = await newDebits(ctx, org, known, 2);
      const commit = pushDebits.find((d) => d.usage?.actionKey === 'presentations.commit');
      const page = pushDebits.find((d) => d.usage?.actionKey === 'files.upload');
      const pushFacts = { deckId, debits: pushDebits.map((d) => ({ amount: d.amount, eventId: d.eventId, actionKey: d.usage?.actionKey })) };
      if (pushDebits.length !== 2 || !commit || !page) throw new CampaignError('the push did not debit one commit and one upload', pushFacts);
      if (commit.amount !== -50) throw new CampaignError('the new deck commit did not debit 50 credits', pushFacts);
      if (page.amount !== -5) throw new CampaignError('the page upload did not debit 5 credits', pushFacts);
      const afterPush = await ctx.hub.account(org);
      if (afterPush.balance !== start.balance - 55) throw new CampaignError('the balance after the push is not the start less 55', { start: start.balance, afterPush: afterPush.balance, ...pushFacts });

      // A staff correction to 12 credits, so the loop takes minutes rather than a thousand uploads.
      const correction = -(afterPush.balance - 12);
      const granted = await ctx.hub.grant(accountId, correction, 'campaign: bring the balance to 12 credits');
      const at12 = await ctx.hub.account(org);
      if (at12.balance !== 12) throw new CampaignError('the staff correction did not leave 12 credits', { correction, granted: granted?.balance, balance: at12.balance });

      // Two 1 MiB uploads with the key: 12 → 7 → 2.
      const beforeUploads = await ledgerIds(ctx, org);
      const accepted = [];
      for (let i = 0; i < 2; i += 1) {
        const res = await ctx.sl.uploadAsset(ws, randomBytes(MIB), { key, label: `loop-accepted-${i + 1}` });
        expectStatus(res, 201, `the 1 MiB upload ${i + 1} at a balance of ${12 - 5 * i}`);
        accepted.push({ status: res.status, sizeBytes: res.json?.sizeBytes, at: Date.now() });
      }
      if (accepted.some((a) => a.sizeBytes !== MIB)) throw new CampaignError('an accepted upload does not report 1 MiB', { accepted });
      await ctx.sl.waitUsageDrained();
      const uploadDebits = await newDebits(ctx, org, beforeUploads, 2);
      const uploadFacts = uploadDebits.map((d) => ({ amount: d.amount, eventId: d.eventId, actionKey: d.usage?.actionKey, balanceAfter: d.balanceAfter }));
      if (uploadDebits.length !== 2 || uploadDebits.some((d) => d.amount !== -5 || d.usage?.actionKey !== 'files.upload')) {
        throw new CampaignError('the two uploads did not debit 5 credits each on files.upload', { uploadDebits: uploadFacts });
      }
      const at2 = await waitFor(async () => ((await ctx.hub.account(org)).balance === 2 ? true : null), { every: 1500, timeoutMs: 30_000 });
      if (!at2) throw new CampaignError('the balance does not read 2 after the two uploads', { balance: (await ctx.hub.account(org)).balance, uploadDebits: uploadFacts });

      // The refused upload: exactly 1 MiB (so its price is 5), sent more than 30 s after
      // the last accepted one, so the cached allowed answer has expired and the hub is asked.
      const cacheWaitMs = Math.max(0, accepted[1].at + 31_000 - Date.now());
      if (cacheWaitMs > 0) await sleep(cacheWaitMs);
      const refusedBytes = randomBytes(MIB);
      const refused = await ctx.sl.uploadAsset(ws, refusedBytes, { key, label: 'loop-refused' });
      const err = refused.json?.error ?? {};
      const d = err.details ?? {};
      const refusal = { status: refused.status, code: err.code, credits: d.credits, balance: d.balance, topUpUrlStartsRight: typeof d.topUpUrl === 'string' && d.topUpUrl.startsWith(`${ctx.config.hub.base}/billing/top-up?org=${org}`) };
      if (refused.status !== 402 || err.code !== 'entitlement_denied') throw new CampaignError('the third upload was not refused 402 entitlement_denied', { ...refusal, body: refused.json ?? refused.text.slice(0, 400) });
      if (d.credits !== 5 || d.balance !== 2) throw new CampaignError('the refusal does not carry the price 5 and the balance 2', refusal);
      if (!refusal.topUpUrlStartsRight) throw new CampaignError('the refusal top-up URL is not the hub top-up page of the organization', { ...refusal, topUpUrl: d.topUpUrl });
      await ctx.sl.waitUsageDrained();
      const after = await ctx.hub.account(org);
      const ledgerAfter = (await ctx.hub.ledger(org, 'debit')).filter((e) => !beforeUploads.has(e.id));
      if (after.balance !== 2 || ledgerAfter.length !== 2) throw new CampaignError('the refused upload changed the ledger', { balance: after.balance, debitsSinceCorrection: ledgerAfter.length });

      s.deckId = deckId;
      s.refusedBytes = refusedBytes;
      return {
        org,
        workspaceId: ws,
        deckId,
        startBalance: start.balance,
        commitDebit: { amount: commit.amount, eventId: commit.eventId },
        pageDebit: { amount: page.amount, eventId: page.eventId },
        balanceAfterPush: afterPush.balance,
        correction,
        correctionNote: 'a staff correction brought the balance to 12 credits so the loop needs two uploads, not a thousand',
        balanceAfterCorrection: at12.balance,
        uploadDebits: uploadFacts,
        balanceAfterUploads: after.balance,
        refusedUploadBytes: MIB,
        cacheHandling: `the refused upload is the same size as the accepted ones and was sent 31 s after the last one (waited ${Math.round(cacheWaitMs / 1000)} s)`,
        refusal
      };
    }
  },
  {
    name: 'it buys a pack in the hub',
    path: 'Slideless + hub + hosted Checkout',
    needs: ['checkout'],
    async run(ctx) {
      const s = state(ctx, 'org', 'refusedBytes');
      const { org } = s;
      const before = await ctx.hub.account(org);
      if (before.balance !== 2) throw new CampaignError('the balance before the purchase is not 2', { balance: before.balance });
      const t0 = Date.now() - 1000;
      const bought = await buyPack(ctx, org, 'loop-pack-1');
      const agrees = await ctx.hub.balanceAgrees(org);
      if (!agrees.agrees || agrees.balance !== 20002) throw new CampaignError('the balance after the purchase is not 20,002 or disagrees with the ledger', { agrees, intentId: bought.intentId });
      const mail = await ctx.mail.waitFor({ to: BILLING_EMAIL, subject: 'credits added to', after: t0 }, 90_000);
      if (!mail) throw new CampaignError('no invoice mail to the billing email within 90 s', { to: BILLING_EMAIL, intentId: bought.intentId });
      const pdf = /Download the PDF: https?:\/\/\S+/.test(mail.Text ?? '');
      s.purchase1 = bought.intentId;
      return {
        org,
        sessionId: bought.sessionId,
        intentId: bought.intentId,
        customerId: bought.customerId || null,
        purchaseEntryId: bought.entry.id,
        purchaseAmount: bought.entry.amount,
        balanceBefore: before.balance,
        balanceAfter: agrees.balance,
        ledgerSum: agrees.sum,
        mailId: mail.ID,
        mailSubject: mail.Subject,
        mailCarriesPdfLink: pdf
      };
    }
  },
  {
    name: 'the same action goes through',
    path: 'Slideless + hub',
    needs: ['checkout'],
    async run(ctx) {
      const s = state(ctx, 'org', 'workspaceId', 'key', 'refusedBytes', 'purchase1');
      const { org, workspaceId: ws, key, refusedBytes } = s;
      const known = await ledgerIds(ctx, org);
      const { res, statuses } = await until201(() => ctx.sl.uploadAsset(ws, refusedBytes, { key, label: 'loop-refused' }));
      if (res.status !== 201) throw new CampaignError('the upload refused before the purchase still does not go through after 40 s', { statuses, body: res.json ?? res.text.slice(0, 400) });
      if (res.json?.sizeBytes !== MIB) throw new CampaignError('the accepted upload does not report 1 MiB', { sizeBytes: res.json?.sizeBytes });
      await ctx.sl.waitUsageDrained();
      const [debit, ...extra] = await newDebits(ctx, org, known, 1);
      const facts = { amount: debit.amount, eventId: debit.eventId, actionKey: debit.usage?.actionKey, extra: extra.length };
      if (extra.length || debit.amount !== -5 || debit.usage?.actionKey !== 'files.upload') throw new CampaignError('the upload did not debit exactly one 5-credit files.upload', facts);
      const agrees = await ctx.hub.balanceAgrees(org);
      if (!agrees.agrees || agrees.balance !== 19997) throw new CampaignError('the balance is not 19,997 or disagrees with the ledger', { agrees, ...facts });
      return { org, attempts: statuses, sha256: res.json?.sha256 ?? null, debit: facts, balance: agrees.balance, ledgerSum: agrees.sum };
    }
  },
  {
    name: "a viewer's form response is paid by the owner, refused when the owner cannot pay, and lands after the top-up",
    path: 'Slideless + hub + hosted Checkout',
    needs: ['checkout'],
    async run(ctx) {
      const s = state(ctx, 'org', 'workspaceId', 'accountId', 'key', 'userId', 'purchase1');
      const { org, workspaceId: ws, accountId, key, userId } = s;
      const start = await ctx.hub.account(org);

      // The deck with the form, and a share link on it.
      const folder = deckFolder(ctx, 'loop-intake', FORM_PAGE);
      const pushed = await ctx.sl.push(folder, { key, ws, title: 'Campaign loop intake' });
      const deckId = pushed?.presentation?.id;
      if (!deckId) throw new CampaignError('the CLI push of the intake deck answered no presentation id', { keys: Object.keys(pushed ?? {}) });
      const minted = await ctx.sl.mintLink(ws, deckId, { name: 'intake', key });
      expectStatus(minted, 201, 'the share link mint on the intake deck');
      const secret = secretOf(minted.json);
      if (!secret) throw new CampaignError('the mint answer carries neither a secret nor a /v/ url', { tokenId: minted.json?.shareToken?.id, fields: Object.keys(minted.json?.shareToken ?? {}) });
      const linkId = minted.json.shareToken.id;
      await ctx.sl.waitUsageDrained();
      const afterSetup = await ctx.hub.account(org);

      // First response: the owner has credits, it lands and costs the owner 1.
      const known1 = await ledgerIds(ctx, org);
      const first = await ctx.sl.formResponse(secret, 'intake', { who: 'a viewer' });
      expectStatus(first, 201, 'the first form response (the owner holds credits)');
      await ctx.sl.waitUsageDrained();
      const [firstDebit, ...extra1] = await newDebits(ctx, org, known1, 1);
      const firstFacts = { amount: firstDebit.amount, eventId: firstDebit.eventId, usage: firstDebit.usage, extra: extra1.length };
      if (extra1.length || firstDebit.amount !== -1) throw new CampaignError('the first response did not debit exactly 1 credit', firstFacts);
      const u = firstDebit.usage;
      if (!u || u.actionKey !== 'forms.response' || u.userId !== userId || u.via !== 'session') {
        throw new CampaignError('the usage event of the response is not forms.response by the owner via session', { ...firstFacts, ownerUserId: userId });
      }
      const afterFirst = await ctx.hub.account(org);

      // A staff correction to 0, then the second response once the cached allowed answer expired.
      const correction = -afterFirst.balance;
      await ctx.hub.grant(accountId, correction, 'campaign: bring the balance to 0 credits');
      const at0 = await ctx.hub.account(org);
      if (at0.balance !== 0) throw new CampaignError('the staff correction did not leave 0 credits', { correction, balance: at0.balance });
      await sleep(31_000);
      const known2 = await ledgerIds(ctx, org);
      const second = await ctx.sl.formResponse(secret, 'intake', { who: 'a viewer' });
      const err = second.json?.error ?? {};
      const message = typeof err.message === 'string' ? err.message : '';
      const sentences = (message.match(/[.!?](\s|$)/g) ?? []).length;
      const refusal = { status: second.status, code: err.code, detailsPresent: err.details !== undefined, message, sentences };
      if (second.status !== 402 || err.code !== 'entitlement_denied') throw new CampaignError('the second response was not refused 402 entitlement_denied', { ...refusal, body: second.json ?? second.text.slice(0, 400) });
      if (err.details !== undefined) throw new CampaignError('the viewer refusal carries details', { ...refusal, detailKeys: Object.keys(err.details ?? {}) });
      if (!message || sentences > 1 || /https?:|\d/.test(message)) throw new CampaignError('the viewer refusal message is not one neutral sentence without numbers or links', refusal);
      await ctx.sl.waitUsageDrained();
      const afterRefusal = await ctx.hub.account(org);
      const debitsAfterRefusal = (await ctx.hub.ledger(org, 'debit')).filter((e) => !known2.has(e.id)).length;
      if (afterRefusal.balance !== 0 || debitsAfterRefusal !== 0) throw new CampaignError('the refused response changed the ledger', { balance: afterRefusal.balance, debitsAfterRefusal });

      // The top-up, then the third response lands and costs 1.
      const bought = await buyPack(ctx, org, 'loop-pack-2');
      if (bought.intentId === s.purchase1) throw new CampaignError('the second purchase reused the first payment intent', { intentId: bought.intentId });
      const afterPack = await ctx.hub.account(org);
      if (afterPack.balance !== 20000) throw new CampaignError('the balance after the second pack is not 20,000', { balance: afterPack.balance, intentId: bought.intentId });
      const known3 = await ledgerIds(ctx, org);
      const { res: third, statuses } = await until201(() => ctx.sl.formResponse(secret, 'intake', { who: 'a viewer' }));
      if (third.status !== 201) throw new CampaignError('the third response did not land within 40 s of the top-up', { statuses, body: third.json ?? third.text.slice(0, 400) });
      await ctx.sl.waitUsageDrained();
      const [thirdDebit, ...extra3] = await newDebits(ctx, org, known3, 1);
      const thirdFacts = { amount: thirdDebit.amount, eventId: thirdDebit.eventId, actionKey: thirdDebit.usage?.actionKey, via: thirdDebit.usage?.via, extra: extra3.length };
      if (extra3.length || thirdDebit.amount !== -1 || thirdDebit.usage?.actionKey !== 'forms.response') throw new CampaignError('the third response did not debit exactly 1 credit on forms.response', thirdFacts);
      const agrees = await ctx.hub.balanceAgrees(org);
      if (!agrees.agrees || agrees.balance !== 19999) throw new CampaignError('the final balance is not 19,999 or disagrees with the ledger', { agrees, ...thirdFacts });

      return {
        org,
        workspaceId: ws,
        deckId,
        linkId,
        balanceAtStart: start.balance,
        balanceAfterDeckAndLink: afterSetup.balance,
        firstResponse: { status: first.status, ...firstFacts, ownerUserId: userId },
        balanceAfterFirst: afterFirst.balance,
        correction,
        balanceAfterCorrection: at0.balance,
        cacheWaitSeconds: 31,
        secondResponse: refusal,
        balanceAfterRefusal: afterRefusal.balance,
        topUp: { sessionId: bought.sessionId, intentId: bought.intentId, entryId: bought.entry.id, balance: afterPack.balance },
        thirdResponse: { attempts: statuses, ...thirdFacts },
        finalBalance: agrees.balance,
        ledgerSum: agrees.sum
      };
    }
  }
];
