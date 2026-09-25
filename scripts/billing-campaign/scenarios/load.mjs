// The billing campaign (PRDCT-2718): load, many organizations buying and consuming at once on the pair.
//
// No scenario here needs lane A. The purchases are payment intents confirmed
// through the Stripe API with `pm_card_visa`. Each intent carries the metadata
// a Checkout's intent carries. The hub writes the purchase from it through its
// own `payment_intent.succeeded` handler. The debits are usage events posted on
// the tool's machine channel, the way Slideless posts them.
import { CampaignError, stats, ulid, waitFor } from '../lib/http.mjs';
import { sqlId } from '../lib/hub.mjs';

export const group = 'load';

/**
 * A bounded concurrency map. At most `limit` calls of `fn` run at once. The
 * results come back in the order of `items`. A call that throws does not stop
 * the others: its slot holds `{ error }` instead of a value.
 */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const worker = async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      try {
        out[i] = { value: await fn(items[i], i) };
      } catch (error) {
        out[i] = { error };
      }
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  return out;
}

/** The message and the evidence of a caught error, for a failure list. */
const describe = (error) => ({
  message: error?.message ?? String(error),
  ...(error instanceof CampaignError ? { evidence: error.evidence } : {})
});

/**
 * An id the pair or Stripe minted, checked before it is written into SQL.
 * UUIDs, ULIDs and Stripe ids use only these characters.
 */
const sqlList = (ids, what) => ids.map((id) => `'${sqlId(id, what)}'`).join(',');

/** The load state that scenario 1 makes, or a clear error when it is missing. */
function loadState(ctx, needBurst = false) {
  const state = ctx.shared.load;
  if (!state?.orgs?.length) {
    throw new CampaignError(
      'the load organizations are missing: scenario 1 of this group did not run or did not finish',
      {}
    );
  }
  if (needBurst && !state.burst) {
    throw new CampaignError(
      'the purchases and the debit batches are missing: scenario 2 of this group did not run or did not finish',
      {}
    );
  }
  return state;
}

const sample = (list, n = 3) => list.slice(0, n);

export const scenarios = [
  {
    name: "N organizations made through the hub's own routes, each with its account and its Stripe customer",
    path: 'Stripe API + hub routes',
    async run(ctx) {
      const N = ctx.config.load.organizations;
      const C = ctx.config.load.concurrency;
      if (!Number.isInteger(N) || N < 1)
        throw new CampaignError('CAMPAIGN_LOAD_ORGS is not a positive whole number', { N });
      if (!Number.isInteger(C) || C < 1)
        throw new CampaignError('CAMPAIGN_LOAD_CONCURRENCY is not a positive whole number', { C });
      const t0 = Date.now();
      ctx.log(`load: making ${N} organizations, ${C} at once`);

      // Phase 1: the organizations, through POST /orgs as Drill Owner.
      const indexes = Array.from({ length: N }, (_, k) => k + 1);
      const made = await pool(indexes, C, async (i) => {
        const org = await ctx.hub.createOrg(`Campaign load ${i}`);
        if (!org) throw new CampaignError(`POST /orgs for organization ${i} answered no id`, { i });
        const account = await ctx.hub.account(org);
        if (!account.accountId) throw new CampaignError(`organization ${i} has no billing account`, { org });
        return { i, org, accountId: account.accountId, startBalance: account.balance, plan: account.plan };
      });
      const capped = made.filter((r) => r.error?.evidence?.status === 403);
      if (capped.length) {
        throw new CampaignError(
          `POST /orgs answered 403 for ${capped.length} of ${N} organizations: the per-person organization cap is on. ` +
            "The runner must boot the hub with MAX_ORGS_PER_USER=0. This is the runner's job, not a product defect.",
          {
            refused: capped.length,
            made: made.filter((r) => r.value).length,
            first: describe(capped[0].error)
          }
        );
      }
      const orgFailures = made
        .map((r, k) => (r.error ? { i: k + 1, ...describe(r.error) } : null))
        .filter(Boolean);
      if (orgFailures.length) {
        throw new CampaignError(`${orgFailures.length} of ${N} organizations could not be made`, {
          failures: sample(orgFailures, 10)
        });
      }
      const orgs = made.map((r) => r.value);
      const orgsMs = Date.now() - t0;

      // Phase 2: the Stripe customers. Stripe's test-mode write limit is about
      // 25 a second, so this phase runs at most 12 at once.
      const t1 = Date.now();
      ctx.log(`load: ${N} organizations made in ${orgsMs} ms; now their Stripe customers`);
      const custs = await pool(orgs, Math.min(C, 12), async (o) => {
        const email = `campaign-load-${o.i}@drill.test`;
        // With lane A merged this PATCH makes the customer. Without it the hub
        // makes none, and the campaign makes one below.
        await ctx.hub.patchAccount(o.org, { billingEmail: email });
        const byHub = await ctx.hub.customerOf(o.org);
        if (byHub) {
          await ctx.stripe.tagCustomer(byHub);
          return { customerId: byHub, byHub: true };
        }
        const customer = await ctx.stripe.post('/v1/customers', {
          email,
          name: `Campaign load ${o.i}`,
          metadata: { accountId: o.accountId, workspaceId: o.org, lane: ctx.config.lane }
        });
        return { customerId: customer.id, byHub: false };
      });
      const custFailures = custs
        .map((r, k) => (r.error ? { i: orgs[k].i, org: orgs[k].org, ...describe(r.error) } : null))
        .filter(Boolean);
      if (custFailures.length) {
        throw new CampaignError(`${custFailures.length} of ${N} Stripe customers could not be made`, {
          failures: sample(custFailures, 10)
        });
      }
      custs.forEach((r, k) => {
        orgs[k].customerId = r.value.customerId;
        orgs[k].customerByHub = r.value.byHub;
      });
      // The customers the campaign made are written on their account rows in
      // ONE statement. Every value is an id the pair or Stripe minted.
      const ours = orgs.filter((o) => !o.customerByHub);
      if (ours.length) {
        const values = ours
          .map((o) => `('${sqlId(o.accountId, 'an account id')}','${sqlId(o.customerId, 'a customer id')}')`)
          .join(',');
        await ctx.hub.sql(
          `UPDATE billing_accounts b SET stripe_customer_id = v.cus FROM (VALUES ${values}) AS v(id, cus) WHERE b.id::text = v.id`
        );
      }
      const written = Number(
        await ctx.hub.sql(
          `SELECT count(*) FROM billing_accounts WHERE id::text IN (${sqlList(
            orgs.map((o) => o.accountId),
            'an account id'
          )}) AND stripe_customer_id IS NOT NULL AND stripe_customer_id <> ''`
        )
      );
      if (written !== N) {
        throw new CampaignError(`only ${written} of ${N} account rows carry a Stripe customer`, {
          written,
          N
        });
      }
      const mismatched = [];
      for (const o of sample(orgs, 5)) {
        const onRow = await ctx.hub.customerOf(o.org);
        if (onRow !== o.customerId) mismatched.push({ i: o.i, org: o.org, expected: o.customerId, onRow });
      }
      if (mismatched.length)
        throw new CampaignError('an account row carries another customer than the one made for it', {
          mismatched
        });
      const customersMs = Date.now() - t1;

      ctx.shared.load = { orgs, N, C };
      const byHub = orgs.filter((o) => o.customerByHub).length;
      return {
        N,
        concurrency: C,
        elapsedMs: Date.now() - t0,
        rateLimitRetries: stats.rateLimitRetries,
        orgsMs,
        customersMs,
        customerPath:
          byHub === N
            ? 'the hub made every customer on the PATCH'
            : byHub === 0
              ? 'made by the campaign and written on the row'
              : `mixed: ${byHub} by the hub, ${N - byHub} by the campaign`,
        rowsWithCustomer: written,
        startBalances: [...new Set(orgs.map((o) => o.startBalance))],
        sample: sample(orgs).map((o) => ({
          i: o.i,
          org: o.org,
          accountId: o.accountId,
          customerId: o.customerId
        }))
      };
    }
  },
  {
    name: 'N purchases and N debit batches at the same moment: no double credit, no lost event',
    path: 'Stripe API + hub routes',
    async run(ctx) {
      const state = loadState(ctx);
      const { orgs, N, C } = state;
      const run = `${ctx.report?.runNumber ?? 'x'}-${ulid().slice(-8)}`;
      const userId = ctx.hub.user?.id;
      if (!userId)
        throw new CampaignError('the hub client has no signed-in user id for the purchase metadata', {});
      ctx.log(`load: ${N} purchases and ${N} debit batches at once, ${C} of each at a time`);

      const t0 = Date.now();
      const [buys, debits] = await Promise.all([
        pool(orgs, C, async (o) => {
          const startedAt = Date.now();
          const intent = await ctx.stripe.purchaseIntent({
            customerId: o.customerId,
            amountMinor: 2000,
            currency: 'EUR',
            metadata: {
              kind: 'purchase',
              accountId: o.accountId,
              workspaceId: o.org,
              userId,
              credits: '20000',
              currency: 'EUR'
            },
            idempotencyKey: `campaign-load-${run}-${o.i}`
          });
          return { intentId: intent.id, status: intent.status, startedAt, created: intent.created };
        }),
        pool(orgs, C, async (o) => {
          const events = [ctx.hub.debitEvent(o.org, 500), ctx.hub.debitEvent(o.org, 250)];
          const answer = await ctx.hub.postUsage(events);
          return { events, answer };
        })
      ]);
      const burstMs = Date.now() - t0;

      const failures = [];
      orgs.forEach((o, k) => {
        const b = buys[k];
        if (b.error) failures.push({ i: o.i, org: o.org, step: 'purchase intent', ...describe(b.error) });
        else if (b.value.status !== 'succeeded')
          failures.push({
            i: o.i,
            org: o.org,
            step: 'purchase intent',
            intentId: b.value.intentId,
            status: b.value.status
          });
        else o.intentId = b.value.intentId;
        const d = debits[k];
        if (d.error) {
          failures.push({ i: o.i, org: o.org, step: 'usage post', ...describe(d.error) });
          return;
        }
        const [e500, e250] = d.value.events;
        o.batch = d.value.events;
        o.debitIds = [e500.id, e250.id];
        const byId = new Map((d.value.answer.results ?? []).map((r) => [r.id, r]));
        const r500 = byId.get(e500.id);
        const r250 = byId.get(e250.id);
        const ok =
          (d.value.answer.results ?? []).length === 2 &&
          r500?.status === 'accepted' &&
          r500.credits === 500 &&
          r250?.status === 'accepted' &&
          r250.credits === 250;
        if (!ok) failures.push({ i: o.i, org: o.org, step: 'usage answer', answer: d.value.answer });
      });

      // Wait for each intent's payment_intent.succeeded, processed by the hub.
      const withIntent = orgs.filter((o) => o.intentId);
      const t1 = Date.now();
      ctx.log(`load: burst done in ${burstMs} ms; waiting for ${withIntent.length} webhooks`);
      const waits = await pool(withIntent, withIntent.length, (o) =>
        ctx.relay.waitProcessed((r) => r.type === 'payment_intent.succeeded' && r.objectId === o.intentId, {
          timeoutMs: 180_000
        })
      );
      let slowestWebhookMs = 0;
      let slowest = null;
      withIntent.forEach((o, k) => {
        const rec = waits[k].value;
        if (!rec) {
          failures.push({
            i: o.i,
            org: o.org,
            step: 'webhook',
            intentId: o.intentId,
            error: waits[k].error
              ? describe(waits[k].error)
              : 'no processed payment_intent.succeeded in 180 s',
            seen: ctx.relay
              .ofObject(o.intentId)
              .map((r) => ({ type: r.type, outcome: r.outcome, status: r.status }))
          });
          o.intentId = null;
          return;
        }
        const ms = rec.lastDeliveredAt - buys[orgs.indexOf(o)].value.startedAt;
        if (ms > slowestWebhookMs) {
          slowestWebhookMs = ms;
          slowest = { i: o.i, intentId: o.intentId, eventId: rec.id };
        }
      });
      const webhooksMs = Date.now() - t1;

      // Judge every organization on its own ledger.
      const t2 = Date.now();
      const judged = await pool(orgs, C, async (o) => {
        const facts = { i: o.i, org: o.org };
        const problems = [];
        if (o.intentId) {
          const landed = await ctx.hub.waitLedger(o.org, { kind: 'purchase', sourceRef: o.intentId }, 60_000);
          const entries = landed ? await ctx.hub.entriesOf(o.org, o.intentId) : [];
          const purchases = entries.filter((e) => e.kind === 'purchase');
          facts.purchases = purchases.map((e) => e.amount);
          if (purchases.length !== 1 || purchases[0].amount !== 20000)
            problems.push('not exactly one purchase of 20000 for the intent');
        } else {
          problems.push('no landed purchase to judge');
        }
        if (o.debitIds) {
          const debitsOnLedger = await ctx.hub.ledger(o.org, 'debit');
          const d500 = debitsOnLedger.filter((e) => e.sourceRef === o.debitIds[0]);
          const d250 = debitsOnLedger.filter((e) => e.sourceRef === o.debitIds[1]);
          facts.debits = { e500: d500.map((e) => e.amount), e250: d250.map((e) => e.amount) };
          if (d500.length !== 1 || d500[0].amount !== -500)
            problems.push('the 500 debit is not on the ledger exactly once at -500');
          if (d250.length !== 1 || d250[0].amount !== -250)
            problems.push('the 250 debit is not on the ledger exactly once at -250');
        } else {
          problems.push('no debit batch to judge');
        }
        const agrees = await ctx.hub.balanceAgrees(o.org);
        const expected = o.startBalance + 20000 - 750;
        facts.balance = agrees.balance;
        facts.sum = agrees.sum;
        facts.expected = expected;
        if (!agrees.agrees) problems.push('the balance is not the ledger sum');
        if (agrees.balance !== expected)
          problems.push(`the balance is not ${expected} (start ${o.startBalance} + 20000 - 750)`);
        o.balanceAfterBurst = agrees.balance;
        return { facts, problems, agrees: agrees.agrees && agrees.balance === expected };
      });
      const judgeMs = Date.now() - t2;
      let agreed = 0;
      orgs.forEach((o, k) => {
        const j = judged[k];
        if (j.error) failures.push({ i: o.i, org: o.org, step: 'judgement', ...describe(j.error) });
        else {
          if (j.value.agrees) agreed += 1;
          if (j.value.problems.length)
            failures.push({ ...j.value.facts, step: 'ledger', problems: j.value.problems });
        }
      });

      state.burst = { run };
      const evidence = {
        N,
        concurrency: C,
        rateLimitRetries: stats.rateLimitRetries,
        burstMs,
        webhooksMs,
        judgeMs,
        elapsedMs: Date.now() - t0,
        slowestWebhookMs,
        slowest,
        balancesAgreed: agreed,
        expectedBalanceAt5000Start: 24250,
        sample: sample(orgs).map((o) => ({
          i: o.i,
          intentId: o.intentId,
          debitIds: o.debitIds,
          balance: o.balanceAfterBurst
        }))
      };
      if (failures.length) {
        throw new CampaignError(
          `${new Set(failures.map((f) => f.i)).size} of ${N} organizations failed the burst`,
          {
            ...evidence,
            failing: failures.length,
            failures: sample(failures, 25)
          }
        );
      }
      return evidence;
    }
  },
  {
    name: 'the same N batches posted again answer duplicate for every event, and the balances do not move',
    path: 'hub routes',
    async run(ctx) {
      const { orgs, N, C } = loadState(ctx, true);
      const missing = orgs.filter((o) => !o.batch || o.balanceAfterBurst === undefined);
      if (missing.length)
        throw new CampaignError('some organizations carry no batch or no balance from scenario 2', {
          missing: missing.map((o) => o.i)
        });
      ctx.log(`load: posting the ${N} batches again`);
      const t0 = Date.now();
      const answers = await pool(orgs, C, (o) => ctx.hub.postUsage(o.batch));
      const postMs = Date.now() - t0;
      const failures = [];
      orgs.forEach((o, k) => {
        const a = answers[k];
        if (a.error) return failures.push({ i: o.i, org: o.org, step: 'usage post', ...describe(a.error) });
        const results = a.value.results ?? [];
        const allDuplicate =
          results.length === 2 && results.every((r) => r.status === 'duplicate') && a.value.accepted === 0;
        const ids = results
          .map((r) => r.id)
          .sort()
          .join(',');
        if (!allDuplicate || ids !== [...o.debitIds].sort().join(','))
          failures.push({ i: o.i, org: o.org, step: 'usage answer', answer: a.value });
        return null;
      });
      const checks = await pool(orgs, C, (o) => ctx.hub.balanceAgrees(o.org));
      orgs.forEach((o, k) => {
        const c = checks[k];
        if (c.error) failures.push({ i: o.i, org: o.org, step: 'balance', ...describe(c.error) });
        else if (!c.value.agrees || c.value.balance !== o.balanceAfterBurst) {
          failures.push({
            i: o.i,
            org: o.org,
            step: 'balance',
            before: o.balanceAfterBurst,
            after: c.value.balance,
            sum: c.value.sum
          });
        }
      });
      const evidence = { N, events: 2 * N, postMs, elapsedMs: Date.now() - t0 };
      if (failures.length) {
        throw new CampaignError(
          `${new Set(failures.map((f) => f.i)).size} of ${N} organizations did not answer duplicate or moved`,
          {
            ...evidence,
            failing: failures.length,
            failures: sample(failures, 25)
          }
        );
      }
      return { ...evidence, duplicates: 2 * N, balancesUnchanged: N };
    }
  },
  {
    name: "the hub's usage_events, stripe_events and ledger agree across the N organizations",
    path: 'hub routes',
    async run(ctx) {
      const { orgs, N } = loadState(ctx, true);
      const withIntent = orgs.filter((o) => o.intentId);
      if (withIntent.length !== N) {
        throw new CampaignError(
          `only ${withIntent.length} of ${N} organizations carry a landed intent from scenario 2`,
          {}
        );
      }
      const t0 = Date.now();
      const accounts = sqlList(
        orgs.map((o) => o.accountId),
        'an account id'
      );
      const intents = sqlList(
        withIntent.map((o) => o.intentId),
        'a payment intent id'
      );
      const usageEvents = Number(
        await ctx.hub.sql(`SELECT count(*) FROM usage_events WHERE account_id::text IN (${accounts})`)
      );
      const stripeRows = (
        await ctx.hub.sql(
          `SELECT count(DISTINCT payload->'data'->'object'->>'id') || '|' || count(*) || '|' || count(*) FILTER (WHERE processed_at IS NULL) FROM stripe_events WHERE type = 'payment_intent.succeeded' AND payload->'data'->'object'->>'id' IN (${intents})`
        )
      ).split('|');
      const [stripeIntents, stripeEventRows, stripeUnprocessed] = stripeRows.map(Number);
      const purchases = Number(
        await ctx.hub.sql(
          `SELECT count(*) FROM credit_ledger WHERE kind = 'purchase' AND source_ref IN (${intents})`
        )
      );
      const disagreeing = Number(
        await ctx.hub.sql(
          `SELECT count(*) FROM (SELECT l.account_id FROM credit_ledger l WHERE l.account_id::text IN (${accounts}) GROUP BY l.account_id HAVING sum(l.amount) <> (SELECT b.balance FROM billing_accounts b WHERE b.id = l.account_id)) x`
        )
      );
      const accountsWithLedger = Number(
        await ctx.hub.sql(
          `SELECT count(DISTINCT account_id) FROM credit_ledger WHERE account_id::text IN (${accounts})`
        )
      );
      const evidence = {
        N,
        usageEvents,
        expectedUsageEvents: 2 * N,
        stripeIntents,
        stripeEventRows,
        stripeUnprocessed,
        purchases,
        disagreeing,
        accountsWithLedger,
        elapsedMs: Date.now() - t0
      };
      const problems = [];
      if (usageEvents !== 2 * N)
        problems.push(`usage_events holds ${usageEvents} rows for the N accounts, not ${2 * N}`);
      if (stripeIntents !== N)
        problems.push(
          `stripe_events holds a payment_intent.succeeded for ${stripeIntents} of the ${N} intents`
        );
      if (stripeUnprocessed !== 0)
        problems.push(`${stripeUnprocessed} payment_intent.succeeded rows are not processed`);
      if (purchases !== N) problems.push(`credit_ledger holds ${purchases} purchases for the ${N} intents`);
      if (accountsWithLedger !== N)
        problems.push(`only ${accountsWithLedger} of the ${N} accounts have ledger rows`);
      if (disagreeing !== 0)
        problems.push(`${disagreeing} accounts have a balance that is not their ledger sum`);
      if (problems.length) throw new CampaignError(problems.join('; '), evidence);
      return evidence;
    }
  },
  {
    name: 'a burst of concurrent debits on ONE organization never overdraws it and every event is answered once',
    path: 'hub routes',
    async run(ctx) {
      const { orgs } = loadState(ctx);
      const o = orgs[0];
      const t0 = Date.now();
      const before = await ctx.hub.balanceAgrees(o.org);
      if (!before.agrees)
        throw new CampaignError('organization 1 did not agree before the burst', { org: o.org, before });
      const B = before.balance;
      ctx.log(`load: 20 concurrent debits of 5 on organization 1 (balance ${B})`);

      // Burst one: 20 batches of one 5-credit event, all at once.
      const small = Array.from({ length: 20 }, () => [ctx.hub.debitEvent(o.org, 5)]);
      const smallAnswers = await Promise.all(small.map((batch) => ctx.hub.postUsage(batch)));
      const smallMs = Date.now() - t0;
      const smallBad = smallAnswers
        .map((a, k) => ({ k, id: small[k][0].id, results: a.results }))
        .filter(
          (x) =>
            x.results?.length !== 1 ||
            x.results[0].id !== x.id ||
            x.results[0].status !== 'accepted' ||
            x.results[0].credits !== 5
        );
      if (smallBad.length)
        throw new CampaignError(`${smallBad.length} of the 20 small debits were not accepted at 5 credits`, {
          org: o.org,
          bad: smallBad
        });
      const afterSmall = await ctx.hub.balanceAgrees(o.org);
      if (!afterSmall.agrees || afterSmall.balance !== B - 100) {
        throw new CampaignError(
          `the balance after 20 debits of 5 is not ${B - 100} or is not the ledger sum`,
          { org: o.org, B, afterSmall }
        );
      }
      const smallIds = new Set(small.map((b) => b[0].id));
      const smallOnLedger = (await ctx.hub.ledger(o.org, 'debit')).filter((e) => smallIds.has(e.sourceRef));
      if (
        smallOnLedger.length !== 20 ||
        new Set(smallOnLedger.map((e) => e.sourceRef)).size !== 20 ||
        smallOnLedger.some((e) => e.amount !== -5)
      ) {
        throw new CampaignError('the 20 small debits are not on the ledger exactly once each at -5', {
          org: o.org,
          onLedger: smallOnLedger.length,
          distinct: new Set(smallOnLedger.map((e) => e.sourceRef)).size
        });
      }
      const evidence = { org: o.org, B, afterSmall: afterSmall.balance, smallMs };

      // Burst two: 20 batches of one 5,000-credit event at once, when the
      // balance cannot cover them all. A debit is never refused at the ingest,
      // so the balance may go below zero; the ledger must still agree.
      if (B - 100 >= 100_000) {
        ctx.report?.note?.(
          'load: the overdraw burst was skipped because organization 1 held 100,000 credits or more.'
        );
        return {
          ...evidence,
          overdrawBurst: 'skipped: the balance covers 100,000 credits',
          elapsedMs: Date.now() - t0
        };
      }
      const t1 = Date.now();
      const big = Array.from({ length: 20 }, () => [ctx.hub.debitEvent(o.org, 5000)]);
      const bigAnswers = await Promise.all(big.map((batch) => ctx.hub.postUsage(batch)));
      const bigMs = Date.now() - t1;
      const results = bigAnswers.map((a, k) => ({ id: big[k][0].id, results: a.results ?? [] }));
      const unanswered = results.filter((x) => x.results.length !== 1 || x.results[0].id !== x.id);
      if (unanswered.length)
        throw new CampaignError(
          `${unanswered.length} of the 20 large debits were not answered exactly once`,
          { org: o.org, unanswered }
        );
      const statuses = results.map((x) => x.results[0].status);
      const rejected = results.filter((x) => x.results[0].status !== 'accepted');
      const acceptedCredits = results
        .filter((x) => x.results[0].status === 'accepted')
        .reduce((s, x) => s + (x.results[0].credits ?? 0), 0);
      const bigIds = new Set(big.map((b) => b[0].id));
      const bigOnLedger = (await ctx.hub.ledger(o.org, 'debit')).filter((e) => bigIds.has(e.sourceRef));
      const ledgerDebited = -bigOnLedger.reduce((s, e) => s + e.amount, 0);
      const afterBig = await ctx.hub.balanceAgrees(o.org);
      Object.assign(evidence, {
        bigMs,
        accepted: statuses.filter((s) => s === 'accepted').length,
        rejected: rejected.length,
        acceptedCredits,
        ledgerDebited,
        bigEntriesOnLedger: bigOnLedger.length,
        afterBig: afterBig.balance,
        afterBigSum: afterBig.sum
      });
      if (rejected.length) {
        throw new CampaignError(
          `${rejected.length} of the 20 large debits were not accepted: the ingest refused a priced debit`,
          {
            ...evidence,
            rejected: rejected.map((x) => x.results[0])
          }
        );
      }
      if (new Set(bigOnLedger.map((e) => e.sourceRef)).size !== bigOnLedger.length) {
        throw new CampaignError('a large debit is on the ledger more than once', evidence);
      }
      if (acceptedCredits !== ledgerDebited)
        throw new CampaignError("the accepted credits are not the ledger's debits added", evidence);
      if (!afterBig.agrees)
        throw new CampaignError('the balance after the large burst is not the ledger sum', evidence);
      if (afterBig.balance !== B - 100 - acceptedCredits) {
        throw new CampaignError(
          `the balance after the large burst is not ${B - 100 - acceptedCredits}`,
          evidence
        );
      }
      if (afterBig.balance >= 5) {
        throw new CampaignError(
          'the balance is still 5 or more after the large burst, so the refusal cannot be judged',
          evidence
        );
      }
      const check = await ctx.hub.usageCheck(o.org, 'files.upload', 1_048_576);
      evidence.check = {
        allowed: check.allowed,
        credits: check.credits,
        balance: check.balance,
        reason: check.reason
      };
      if (check.allowed !== false)
        throw new CampaignError('the usage check allows a 5-credit upload on a balance under 5', evidence);
      return { ...evidence, elapsedMs: Date.now() - t0 };
    }
  }
];
