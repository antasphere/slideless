<script lang="ts">
  import * as Sidebar from '$lib/components/ui/sidebar/index.js';
  import AppSidebar from '$lib/components/sidebar/AppSidebar.svelte';
  import HeroStage from '$lib/components/brand/HeroStage.svelte';
  import PageField from '$lib/components/brand/PageField.svelte';
  import PhoneTabBar from '$lib/components/shell/PhoneTabBar.svelte';
  import PhoneTopBar from '$lib/components/shell/PhoneTopBar.svelte';
  import TopCrumbs from '$lib/components/shell/TopCrumbs.svelte';
  import { HeadWatch } from '$lib/components/shell/headWatch.svelte';
  import { pathCrumbs } from '$lib/components/shell/path';
  import WelcomeBanner from '$lib/components/shared/WelcomeBanner.svelte';
  import { page } from '$app/state';
  import { crumbs } from '$lib/crumbs.svelte';
  import { buildNav, phoneTabs } from '$lib/nav';
  import { fieldPalette, look } from '$lib/look.svelte';
  import { theme } from '$lib/theme.svelte';
  import { listScope } from '$lib/stores/pagedList.svelte';
  import { warmLists } from '$lib/stores/warmLists';

  let { data, children } = $props();

  // the lists a page remembers are one person's in one workspace
  $effect.pre(() => listScope(`${data.me.user.id}:${data.me.activeWorkspaceId ?? ''}`));
  // ...and once the app is idle they are fetched ahead, so a first visit to
  // a page opens on its rows too (again after a switch of workspace)
  $effect(() => {
    void data.me.activeWorkspaceId;
    const idle = window.requestIdleCallback ?? ((run: () => void) => setTimeout(run, 400));
    idle(() => warmLists());
  });

  const nav = $derived(buildNav({ role: data.me.role, origin: data.me.origin }));
  const tabs = $derived(phoneTabs(nav));

  // The path in the top bar: where the page sits in the navigation, then what
  // the page itself adds (a deck's title). It shows only once the page's own
  // header has scrolled away; on a phone the same moment puts the page's name
  // in the phone bar, in place of the workspace's.
  const head = new HeadWatch();
  const trail = $derived([...pathCrumbs(nav, page.url.pathname), ...crumbs.extra]);
  const pageName = $derived(trail[trail.length - 1]?.label);
  const workspaceName = $derived(
    data.me.workspaces.find((w) => w.id === data.me.activeWorkspaceId)?.name ?? data.instance.name
  );

  // The workspace's look (a fact of the workspace, /me carries it): the
  // theme's slots on <html>, its field under the app at the workspace's own
  // gradient and grain. A switch changes the look with the workspace.
  $effect(() => {
    theme.start();
    look.use(data.me.activeWorkspaceId ?? '', data.me.workspace.look);
    look.apply(theme.dark);
  });
  const field = $derived(fieldPalette(look.value.theme, theme.dark));
</script>

<!-- The page's ground (PRDCT-2439): the Labs paper as a seeded field under a
     film grain, fixed behind the whole signed-in app. The sidebar sits
     straight on it; the content is a translucent plate over it. -->
<PageField palette={field} opacity={look.value.field} grain={look.value.grain * 2} />

<Sidebar.Provider class="relative z-10 !bg-transparent">
  <AppSidebar
    instanceName={data.instance.name}
    role={data.me.role}
    user={{ name: data.me.user.name, email: data.me.user.email }}
    workspaces={data.me.workspaces}
    activeWorkspaceId={data.me.activeWorkspaceId}
    origin={data.me.origin}
    hubManageUrl={data.me.hubManageUrl}
    canCreateWorkspace={data.me.canCreateWorkspace}
  />
  <Sidebar.Inset class="app-plate">
    <!-- a phone has no sidebar: its own header, and the tab bar below -->
    <PhoneTopBar
      name={workspaceName}
      workspaceId={data.me.activeWorkspaceId ?? ''}
      title={head.gone ? pageName : undefined}
      user={{ name: data.me.user.name, email: data.me.user.email }}
    />
    <header
      class="top-bar hidden h-11 shrink-0 items-center gap-3 px-1.5 md:flex"
      data-stuck={head.gone ? '' : undefined}
    >
      <Sidebar.Trigger />
      <TopCrumbs items={trail} shown={head.gone && trail.length > 0} />
    </header>
    <main class="app-main flex-1 overflow-y-auto px-4 pt-5 md:px-8 md:pt-2" use:head.attach>
      <div class="mx-auto w-full max-w-6xl">
        {#if data.me.firstRunPending}
          <!-- SL-6: cloud + sessions only — the field is absent on oss. -->
          <WelcomeBanner instanceName={data.instance.name} />
        {/if}
        <!-- the band every page opens on: one element that stays while the
             pages change, each page saying what it holds (HeroBand) -->
        <HeroStage />
        {@render children()}
      </div>
    </main>
  </Sidebar.Inset>
  <PhoneTabBar {tabs} />
</Sidebar.Provider>
