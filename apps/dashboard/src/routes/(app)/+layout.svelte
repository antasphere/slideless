<script lang="ts">
  import * as Sidebar from '$lib/components/ui/sidebar/index.js';
  import { Separator } from '$lib/components/ui/separator/index.js';
  import AppSidebar from '$lib/components/sidebar/AppSidebar.svelte';

  let { data, children } = $props();
</script>

<Sidebar.Provider>
  <AppSidebar
    instanceName={data.instance.name}
    role={data.me.role}
    user={{ name: data.me.user.name, email: data.me.user.email }}
    workspaces={data.me.workspaces}
    activeWorkspaceId={data.me.activeWorkspaceId}
    origin={data.me.origin}
    hubOrigin={data.me.workspace.hubOrigin}
  />
  <Sidebar.Inset>
    <header class="flex h-12 shrink-0 items-center gap-2 px-4">
      <Sidebar.Trigger class="-ml-1" />
      <Separator orientation="vertical" class="mr-2 h-4" />
      <span class="text-sm text-muted-foreground">{data.instance.name}</span>
    </header>
    <main class="flex-1 overflow-y-auto px-6 pb-10 pt-4">
      <div class="mx-auto w-full max-w-6xl">
        {@render children()}
      </div>
    </main>
  </Sidebar.Inset>
</Sidebar.Provider>
