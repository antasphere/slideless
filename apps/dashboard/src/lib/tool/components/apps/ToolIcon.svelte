<!-- The sidebar icon of a tool, from its registry descriptor (PRDCT-3493):
     one lucide component per name of the contract's closed TOOL_ICONS list,
     the grid for a tool with no icon or a name this build does not know (a
     newer hub may name one the dashboard has not shipped yet). The twin is
     the hub's `lib/components/apps/ToolIcon.svelte`. -->
<script lang="ts" module>
  import type { Component } from 'svelte';
  import Bot from '@lucide/svelte/icons/bot';
  import Briefcase from '@lucide/svelte/icons/briefcase';
  import Building2 from '@lucide/svelte/icons/building-2';
  import CalendarClock from '@lucide/svelte/icons/calendar-clock';
  import ChartColumn from '@lucide/svelte/icons/chart-column';
  import Contact from '@lucide/svelte/icons/contact';
  import FileText from '@lucide/svelte/icons/file-text';
  import FolderKanban from '@lucide/svelte/icons/folder-kanban';
  import Globe from '@lucide/svelte/icons/globe';
  import Inbox from '@lucide/svelte/icons/inbox';
  import KeyRound from '@lucide/svelte/icons/key-round';
  import Landmark from '@lucide/svelte/icons/landmark';
  import Layers from '@lucide/svelte/icons/layers';
  import LayoutGrid from '@lucide/svelte/icons/layout-grid';
  import Mail from '@lucide/svelte/icons/mail';
  import Megaphone from '@lucide/svelte/icons/megaphone';
  import PenLine from '@lucide/svelte/icons/pen-line';
  import Presentation from '@lucide/svelte/icons/presentation';
  import QrCode from '@lucide/svelte/icons/qr-code';
  import Receipt from '@lucide/svelte/icons/receipt';
  import Rocket from '@lucide/svelte/icons/rocket';
  import ShieldCheck from '@lucide/svelte/icons/shield-check';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import Trophy from '@lucide/svelte/icons/trophy';
  import Users from '@lucide/svelte/icons/users';
  import Wallet from '@lucide/svelte/icons/wallet';
  import type { ToolIcon as ToolIconName } from '@antasphere/chassis-contract';

  /** One component per name of TOOL_ICONS; the contract's list and this map are pinned equal by a test. */
  export const TOOL_ICON_COMPONENTS: Record<ToolIconName, Component> = {
    landmark: Landmark,
    users: Users,
    'calendar-clock': CalendarClock,
    contact: Contact,
    'key-round': KeyRound,
    mail: Mail,
    'pen-line': PenLine,
    layers: Layers,
    presentation: Presentation,
    trophy: Trophy,
    'layout-grid': LayoutGrid,
    briefcase: Briefcase,
    'folder-kanban': FolderKanban,
    receipt: Receipt,
    wallet: Wallet,
    'building-2': Building2,
    'shield-check': ShieldCheck,
    globe: Globe,
    bot: Bot,
    sparkles: Sparkles,
    'file-text': FileText,
    inbox: Inbox,
    megaphone: Megaphone,
    'qr-code': QrCode,
    'chart-column': ChartColumn,
    rocket: Rocket
  };

  /** The component for a descriptor's icon name; the grid when there is none or it is unknown. */
  export function toolIconComponent(name: string | undefined | null): Component {
    return (name && (TOOL_ICON_COMPONENTS as Record<string, Component>)[name]) || LayoutGrid;
  }
</script>

<script lang="ts">
  let { name, class: className = '' }: { name?: string | null; class?: string } = $props();
  const Icon = $derived(toolIconComponent(name));
</script>

<Icon class={className} />
