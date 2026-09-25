#!/usr/bin/env node
// The billing campaign (PRDCT-2718): the orchestrator. Started by
// scripts/billing-campaign.sh with the pair up, the Stripe variables in the
// environment and `stripe listen` forwarding to the relay's port. Runs the
// scenario groups in order (each file under scenarios/ exports `group` and
// `scenarios`), writes campaign/run-<n>/results.json after every scenario and
// report.md at the end, and exits non-zero on any red or unrun scenario.
//
//   node scripts/billing-campaign/run.mjs [--groups buying,cards] [--run <n>] [--only <scenario name>]
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from './lib/config.mjs';
import { closeBrowser, payCheckout } from './lib/checkout.mjs';
import { CampaignError, request } from './lib/http.mjs';
import { Hub } from './lib/hub.mjs';
import { Mailpit } from './lib/mailpit.mjs';
import { Relay } from './lib/relay.mjs';
import { Report } from './lib/report.mjs';
import { Slideless } from './lib/slideless.mjs';
import { Stripe } from './lib/stripe.mjs';

export const GROUPS = [
  'buying',
  'cards',
  'plan',
  'auto-recharge',
  'refunds-and-referrals',
  'webhooks',
  'load',
  'loop'
];

function args() {
  const out = { groups: GROUPS, run: undefined, only: null };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === '--groups')
      out.groups = a[++i]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    else if (a[i] === '--run') out.run = Number(a[++i]);
    else if (a[i] === '--only') out.only = a[++i];
  }
  return out;
}

const stamp = () => new Date().toISOString().slice(11, 19);
const log = (...parts) => console.log(`[${stamp()}]`, ...parts);

async function heads() {
  const git = async (dir) => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    try {
      const { stdout } = await promisify(execFile)('git', ['-C', dir, 'rev-parse', '--short', 'HEAD']);
      return stdout.trim();
    } catch {
      return 'unknown';
    }
  };
  const hubDir = process.env.FEDERATION_HUB_DIR ?? path.join(config.repo, '../../../hub');
  return { hub: await git(hubDir), slideless: await git(config.repo), pair: config.project };
}

/**
 * The images the pair's hub and Slideless containers RUN, read from Docker:
 * the worktree heads above say what was checked out, the image ids say what
 * answered the scenarios (an image built before a worktree moved is the older
 * code, whatever the head reads).
 */
async function runningImages(hub) {
  const out = { hub: null, app: null };
  try {
    const { stdout } = await hub.compose(['images', '--format', 'json']);
    for (const row of JSON.parse(stdout)) {
      const which = row.ContainerName.endsWith('-hub-1')
        ? 'hub'
        : row.ContainerName.endsWith('-app-1')
          ? 'app'
          : null;
      if (!which) continue;
      let created = null;
      try {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const env = {
          ...process.env,
          ...(config.compose.dockerConfig ? { DOCKER_CONFIG: config.compose.dockerConfig } : {})
        };
        const { stdout: created0 } = await promisify(execFile)(
          'docker',
          ['image', 'inspect', row.ID, '--format', '{{.Created}}'],
          { env }
        );
        created = created0.trim();
      } catch {
        created = null;
      }
      out[which] = {
        image: `${row.Repository}:${row.Tag}`,
        id: row.ID.replace('sha256:', '').slice(0, 12),
        created
      };
    }
  } catch {
    /* the pair is not up through compose (a foreign pair): no image facts */
  }
  return out;
}

async function main() {
  const opts = args();
  const mail = new Mailpit(config.mailPort);
  const hub = new Hub({ mail, log });
  const sl = new Slideless({ hub, log });
  const stripe = new Stripe();
  const relay = new Relay();
  // The run's directory is made only once the preflight passed: a pair that
  // does not answer must not leave a hollow run-<n> in the bundle.
  const notes = [];

  // ── preflight: the pair answers, the owner is signed in, the price book is seeded ──
  for (const [name, target] of [
    ['the hub', config.hub],
    ['Slideless', config.sl]
  ]) {
    const res = await request(target, { path: '/healthz', timeoutMs: 5000 }).catch(() => ({ status: 0 }));
    if (res.status !== 200) throw new Error(`${name} does not answer on ${target.port}: is the pair up?`);
  }
  await relay.start();
  log(`relay listening on 127.0.0.1:${relay.port}`);
  await hub.signInOwner(path.join(config.out, '.owner-password'));
  const drillOrg = await hub.drillOrg();
  const prices = await hub.prices();
  if (!prices.prices?.length) {
    await hub.seedPrices();
    notes.push(
      "The price book was empty at the start of the run; the campaign seeded it from Slideless's discovery as staff does."
    );
  }
  await sl.signInWithHub();
  // What the hub carries: lane A's checkout (a 501 stub until PRDCT-2715 merges).
  const probe = await hub.checkout(drillOrg, { pack: 20000 });
  const laneA = probe.status !== 501;
  if (!laneA)
    notes.push(
      'POST /billing/checkout answers 501 not_implemented on this hub: lane A (PRDCT-2715) is not merged; every scenario that buys is reported unrun.'
    );
  log(
    `preflight: owner ${hub.user.email}, Drill Workspace ${drillOrg}, checkout ${laneA ? 'available' : 'NOT available (501)'}, prices ${prices.prices?.length ?? 0}`
  );
  const report = new Report({
    bundleDir: config.bundleDir,
    runNumber: opts.run,
    heads: { ...(await heads()), images: await runningImages(hub) }
  });
  for (const n of notes) report.note(n);
  log(`run ${report.runNumber} → ${report.dir}`);

  const ctx = { config, hub, sl, stripe, relay, mail, report, drillOrg, laneA, payCheckout, log, shared: {} };

  let failed = 0;
  let ran = 0;
  for (const groupName of opts.groups) {
    const file = path.join(config.repo, 'scripts/billing-campaign/scenarios', `${groupName}.mjs`);
    let mod;
    try {
      mod = await import(pathToFileURL(file).href);
    } catch (err) {
      log(`group ${groupName}: cannot load (${err.message})`);
      report.add({
        group: groupName,
        name: `(load ${groupName}.mjs)`,
        status: 'red',
        error: String(err.message),
        evidence: {},
        durationMs: 0
      });
      failed += 1;
      continue;
    }
    log(`── group ${mod.group ?? groupName} (${mod.scenarios.length} scenarios)`);
    for (const sc of mod.scenarios) {
      if (opts.only && sc.name !== opts.only) continue;
      ran += 1;
      const t0 = Date.now();
      const row = {
        group: mod.group ?? groupName,
        name: sc.name,
        path: sc.path ?? null,
        status: 'red',
        evidence: {},
        durationMs: 0
      };
      try {
        if (sc.needs?.includes('checkout') && !laneA) {
          row.status = 'unrun';
          row.reason = "needs lane A's checkout (PRDCT-2715), which this hub does not carry";
        } else {
          const evidence = await sc.run(ctx);
          row.status = 'green';
          row.evidence = evidence ?? {};
        }
      } catch (err) {
        row.status = 'red';
        row.error = err?.message ?? String(err);
        row.evidence =
          err instanceof CampaignError
            ? err.evidence
            : {
                stack: String(err?.stack ?? '')
                  .split('\n')
                  .slice(0, 4)
                  .join(' ')
              };
        failed += 1;
      }
      row.durationMs = Date.now() - t0;
      report.add(row);
      log(
        `  ${row.status.padEnd(5)} ${sc.name} (${(row.durationMs / 1000).toFixed(1)} s)${row.error ? ` — ${row.error}` : ''}`
      );
      relay.unhold();
      relay.discard();
    }
  }

  // A run in which nothing ran proved nothing and must not read as green: an
  // `--only` that matches no name, or an empty group list, is a failure.
  if (ran === 0) {
    const why = opts.only
      ? `--only "${opts.only}" matched no scenario in ${opts.groups.join(', ')}`
      : `no scenario ran in ${opts.groups.join(', ')}`;
    report.note(`${why}: the run proved nothing.`);
    failed += 1;
    log(`  red   ${why}`);
  }
  const finished = new Date();
  const results = report.write(finished);
  report.markdown(finished);
  await closeBrowser();
  await relay.stop();
  log(
    `done: ${results.tally.green} green · ${results.tally.red} red · ${results.tally.unrun} unrun → ${report.dir}`
  );
  const unrun = results.tally.unrun;
  process.exit(failed > 0 || unrun > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`campaign: ${err?.stack ?? err}`);
  if (err instanceof CampaignError && err.evidence)
    console.error(`campaign: evidence ${JSON.stringify(err.evidence).slice(0, 2000)}`);
  process.exit(2);
});
