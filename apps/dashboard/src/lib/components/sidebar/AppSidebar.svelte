<script lang="ts">
  import { page } from '$app/state';
  import * as Sidebar from '$lib/components/ui/sidebar/index.js';
  import NavUser from './NavUser.svelte';
  import LayoutDashboard from '@lucide/svelte/icons/layout-dashboard';
  import Users from '@lucide/svelte/icons/users';
  import Mail from '@lucide/svelte/icons/mail';
  import KeyRound from '@lucide/svelte/icons/key-round';
  import Folder from '@lucide/svelte/icons/folder';
  import ScrollText from '@lucide/svelte/icons/scroll-text';
  import Settings from '@lucide/svelte/icons/settings';
  import { t } from '$lib/i18n';
  import type { WorkspaceRole } from '@platform/contract';

  interface Props {
    instanceName: string;
    role: WorkspaceRole;
    user: { name: string; email: string };
  }

  let { instanceName, role, user }: Props = $props();

  const isAdmin = $derived(role === 'owner' || role === 'admin');

  const navGroups = $derived([
    {
      label: t('nav.platform'),
      items: [
        { title: t('nav.overview'), href: '/', icon: LayoutDashboard },
        { title: t('nav.members'), href: '/members', icon: Users },
        ...(isAdmin ? [{ title: t('nav.invitations'), href: '/invitations', icon: Mail }] : []),
        { title: t('nav.apiKeys'), href: '/api-keys', icon: KeyRound },
        { title: t('nav.files'), href: '/files', icon: Folder }
      ]
    },
    {
      label: t('nav.system'),
      items: [
        ...(isAdmin ? [{ title: t('nav.auditLog'), href: '/audit', icon: ScrollText }] : []),
        { title: t('nav.settings'), href: '/settings', icon: Settings }
      ]
    }
  ]);

  const currentPath = $derived(page.url.pathname);

  function isActive(href: string): boolean {
    return href === '/' ? currentPath === '/' : currentPath.startsWith(href);
  }

  const initial = $derived((instanceName || 'P').slice(0, 1).toUpperCase());
</script>

<Sidebar.Root variant="inset" collapsible="icon">
  <Sidebar.Header>
    <div class="flex items-center gap-2 px-2 py-2">
      <div
        class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground shadow-sm"
      >
        {initial}
      </div>
      <span class="truncate text-sm font-semibold">{instanceName}</span>
    </div>
  </Sidebar.Header>
  <Sidebar.Content>
    {#each navGroups as group (group.label)}
      <Sidebar.Group>
        <Sidebar.GroupLabel>{group.label}</Sidebar.GroupLabel>
        <Sidebar.Menu>
          {#each group.items as item (item.href)}
            <Sidebar.MenuItem>
              <Sidebar.MenuButton
                isActive={isActive(item.href)}
                class="transition-[transform,background-color] duration-200 hover:translate-x-0.5 hover:!bg-sidebar-accent/75 hover:!text-sidebar-accent-foreground"
              >
                {#snippet child({ props }: { props: Record<string, unknown> })}
                  <a href={item.href} {...props}>
                    <item.icon class="text-muted-foreground transition-transform" />
                    <span>{item.title}</span>
                  </a>
                {/snippet}
              </Sidebar.MenuButton>
            </Sidebar.MenuItem>
          {/each}
        </Sidebar.Menu>
      </Sidebar.Group>
    {/each}
  </Sidebar.Content>
  <Sidebar.Footer>
    <NavUser {user} />
  </Sidebar.Footer>
</Sidebar.Root>
