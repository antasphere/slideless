<script lang="ts">
  import * as Sidebar from '$lib/components/ui/sidebar/index.js';
  import AppSidebar from '$lib/components/sidebar/AppSidebar.svelte';
  import PageField from '$lib/components/brand/PageField.svelte';
  import PhoneTabBar from '$lib/components/shell/PhoneTabBar.svelte';
  import PhoneTopBar from '$lib/components/shell/PhoneTopBar.svelte';
  import WelcomeBanner from '$lib/components/shared/WelcomeBanner.svelte';
  import { buildNav, phoneTabs } from '$lib/nav';

  let { data, children } = $props();

  const tabs = $derived(phoneTabs(buildNav({ role: data.me.role, origin: data.me.origin })));
  const workspaceName = $derived(
    data.me.workspaces.find((w) => w.id === data.me.activeWorkspaceId)?.name ?? data.instance.name
  );
</script>

<!-- The page's ground (PRDCT-2439): the Labs paper as a seeded field under a
     film grain, fixed behind the whole signed-in app. The sidebar sits
     straight on it; the content is a translucent plate over it. -->
<PageField palette="labs-field" strength="soft" />

<Sidebar.Provider class="relative z-10 !bg-transparent">
  <AppSidebar
    instanceName={data.instance.name}
    role={data.me.role}
    user={{ name: data.me.user.name, email: data.me.user.email }}
    workspaces={data.me.workspaces}
    activeWorkspaceId={data.me.activeWorkspaceId}
    origin={data.me.origin}
    hubManageUrl={data.me.hubManageUrl}
  />
  <Sidebar.Inset class="app-plate">
    <!-- a phone has no sidebar: its own header, and the tab bar below -->
    <PhoneTopBar name={workspaceName} user={{ name: data.me.user.name, email: data.me.user.email }} />
    <header class="hidden h-11 shrink-0 items-center gap-2 px-4 md:flex">
      <Sidebar.Trigger class="-ml-1" />
    </header>
    <main class="app-main flex-1 overflow-y-auto px-4 pt-5 md:px-8 md:pt-2">
      <div class="mx-auto w-full max-w-6xl">
        {#if data.me.firstRunPending}
          <!-- SL-6: cloud + sessions only — the field is absent on oss. -->
          <WelcomeBanner instanceName={data.instance.name} />
        {/if}
        {@render children()}
      </div>
    </main>
  </Sidebar.Inset>
  <PhoneTabBar {tabs} />
</Sidebar.Provider>
