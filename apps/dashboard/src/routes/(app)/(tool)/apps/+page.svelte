<!-- The Apps page: the other tools of the person's organization, and the
     account that signs them in. One card per tool they may open (AppCard),
     the account's first, then this tool's own, which says "You are here",
     then the others by name; each draws and says what its registry
     descriptor declares (PRDCT-3493). The list
     is the server's (`GET /apps`): on the cloud edition the hub asked as the
     person, on a self-hosted instance the operator's file. When neither
     lists anything, a plate says so and names the setting; when the hub says
     the organization is suspended, the plate says that instead. -->
<script lang="ts">
  import SectionHero from '$lib/components/shared/SectionHero.svelte';
  import { Skeleton } from '$lib/components/ui/skeleton/index.js';
  import { appear } from '$lib/components/ui/reveal/index.js';
  import AppCard from '$lib/tool/components/apps/AppCard.svelte';
  import AppDrawing from '$lib/tool/components/apps/AppDrawing.svelte';
  import { appFact, appSentence, hereFirst } from '$lib/tool/apps';
  import { errorMessage } from '$lib/api';
  import { loadApps } from '$lib/tool/apps';
  import { t } from '$lib/i18n';
  import type { AppsList } from '@antasphere/chassis-contract';

  let { data } = $props();

  let list = $state<AppsList | null>(null);
  let loadError = $state<string | null>(null);

  async function load() {
    try {
      list = await loadApps();
      loadError = null;
    } catch (e) {
      loadError = errorMessage(e, t('apps.loadError'));
    }
  }

  $effect(() => {
    void load();
  });

  // the empty plate's sentence names the setting, set apart as code
  const KEY_MARK = '\u0000';
  const emptyBody = $derived(t('apps.emptyBody', { key: KEY_MARK }).split(KEY_MARK));
  // the hub suspended the organization: the list is empty by rule, the plate says so
  const suspended = $derived(list?.organization?.status === 'suspended' ? list.organization : null);
</script>

<svelte:head>
  <title>{t('apps.title')} · {data.instance.name}</title>
</svelte:head>

<SectionHero eyebrow={t('apps.eyebrow')} title={t('apps.title')} lede={t('apps.lede')} drawing="lattice" />

{#if loadError && !list}
  <p class="text-sm text-destructive" in:appear data-testid="apps-error">{loadError}</p>
{:else if !list}
  <div class="grid gap-5 md:grid-cols-2 xl:grid-cols-3" aria-busy="true">
    {#each [0, 1, 2] as i (i)}
      <Skeleton class="h-[300px] rounded-[var(--r-lg)]" />
    {/each}
  </div>
{:else}
  <div class="grid gap-5 md:grid-cols-2 xl:grid-cols-3" in:appear data-testid="apps-grid">
    {#if list.hub}
      <AppCard
        slug="hub"
        name={list.hub.name}
        drawing="rings"
        sentence={t('apps.descHub')}
        href={list.hub.url}
        action={t('apps.openHub')}
      />
    {/if}
    {#each hereFirst(list.apps) as app (app.slug)}
      <AppCard
        slug={app.slug}
        name={app.name}
        drawing={app.descriptor?.drawing}
        accent={app.descriptor?.accent}
        sentence={appSentence(app)}
        fact={appFact(app)}
        href={app.launchUrl}
        current={app.current}
        action={t('apps.open')}
      />
    {/each}
  </div>

  {#if suspended}
    <section class="empty" class:alone={!list.hub} in:appear data-testid="apps-suspended">
      <div class="empty-drawing"><AppDrawing name="?" /></div>
      <div>
        <h2 class="empty-title">
          {suspended.name
            ? t('apps.suspendedTitle', { name: suspended.name })
            : t('apps.suspendedTitleGeneric')}
        </h2>
        <p class="empty-body">{t('apps.suspendedBody')}</p>
      </div>
    </section>
  {:else if list.apps.length === 0}
    <section class="empty" class:alone={!list.hub} in:appear data-testid="apps-empty">
      <div class="empty-drawing"><AppDrawing name="?" /></div>
      <div>
        <h2 class="empty-title">{t('apps.emptyTitle')}</h2>
        <p class="empty-body">{emptyBody[0]}<code>APPS_FILE</code>{emptyBody[1] ?? ''}</p>
      </div>
    </section>
  {/if}
{/if}

<style>
  .empty {
    display: flex;
    align-items: center;
    gap: 24px;
    margin-top: 20px;
    padding: 22px 26px;
    border: 1px dashed var(--hairline);
    border-radius: var(--r-lg);
    background: var(--plate);
  }
  .empty.alone {
    margin-top: 0;
  }
  .empty-drawing {
    flex: 0 0 150px;
    opacity: 0.85;
  }
  .empty-title {
    font-family: var(--display);
    font-weight: 400;
    font-size: 19px;
    line-height: 1.2;
    color: var(--ink);
  }
  .empty-body {
    margin-top: 6px;
    max-width: 52ch;
    font-size: 13.5px;
    line-height: 1.5;
    color: var(--muted);
  }
  .empty-body code {
    font-family: var(--mono);
    font-size: 12.5px;
    margin: 0 1px;
    padding: 1px 4px;
    border-radius: 5px;
    background: color-mix(in oklab, var(--ground-2) 70%, transparent);
    color: var(--ink);
  }
  @media (max-width: 640px) {
    .empty {
      flex-direction: column;
      align-items: flex-start;
    }
    .empty-drawing {
      flex-basis: auto;
      width: 150px;
    }
  }
</style>
