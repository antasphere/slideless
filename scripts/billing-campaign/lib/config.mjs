// The billing campaign (PRDCT-2718): the configuration every scenario reads.
// Everything comes from the environment the runner (scripts/billing-campaign.sh)
// exports; the defaults are the federation drill's, so the campaign runs on
// the pair the drill booted. The Stripe key is read here and printed nowhere.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = (name, fallback) => {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
};

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function readConfig() {
  const project = env('FEDERATION_PROJECT', 'slideless-federation');
  const hubPort = Number(env('FEDERATION_HUB_PORT', '3300'));
  const slPort = Number(env('FEDERATION_SL_PORT', '3310'));
  const stripeKey = env('STRIPE_SANDBOX_SECRET_KEY', env('STRIPE_SECRET_KEY', ''));
  if (!stripeKey.startsWith('sk_test_')) {
    throw new Error(
      'STRIPE_SANDBOX_SECRET_KEY must be a Stripe TEST secret key (sk_test_…); nothing else is ever used'
    );
  }
  const webhookSecret = env('STRIPE_WEBHOOK_SECRET', '');
  if (!webhookSecret.startsWith('whsec_')) {
    throw new Error(
      'STRIPE_WEBHOOK_SECRET must be the listen secret (whsec_…), from `stripe listen --print-secret`'
    );
  }
  const out = env('CAMPAIGN_OUT', `/private/tmp/billing-campaign-${project}`);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  return {
    repo,
    project,
    out,
    /** Where campaign/run-<n>/ is written: the workstream bundle, or the OUT folder. */
    bundleDir: env('CAMPAIGN_BUNDLE', out),
    hub: { host: 'hub.localhost', port: hubPort, base: `http://hub.localhost:${hubPort}` },
    sl: { host: 'slideless.localhost', port: slPort, base: `http://slideless.localhost:${slPort}` },
    mailPort: Number(env('FEDERATION_MAIL_PORT', '8030')),
    hopPort: Number(env('FEDERATION_HOP_PORT', '8474')),
    relayPort: Number(env('CAMPAIGN_RELAY_PORT', '8732')),
    /** The registry client of the pair's Slideless (docker-compose.federation.yml). */
    toolClient: {
      id: 'tool-slideless-cloud',
      secret: 'federation-dev-client-secret-0001',
      slug: 'slideless-cloud'
    },
    metricsToken: 'federation-dev-metrics-token-0001',
    owner: { email: 'drill-owner@drill.test', name: 'Drill Owner' },
    /** The sandbox tag on every object the campaign creates itself. */
    lane: env('CAMPAIGN_LANE', 'billing3-d'),
    stripeKey,
    webhookSecret,
    headed: env('CAMPAIGN_HEADED', '') === '1',
    /** The compose files of the pair, for `docker compose exec` and the hub's recreate. */
    compose: {
      files: [
        path.join(repo, 'docker-compose.federation.yml'),
        path.join(repo, 'docker-compose.federation.drill.yml')
      ],
      dockerConfig: env('DOCKER_CONFIG', '')
    },
    /** How many organizations the load group makes and how many purchases and debit batches it runs at once. */
    load: {
      organizations: Number(env('CAMPAIGN_LOAD_ORGS', '120')),
      concurrency: Number(env('CAMPAIGN_LOAD_CONCURRENCY', '12'))
    }
  };
}

export const config = readConfig();
