<script lang="ts">
  /* The three roles of a project, each with one line on what it gives: the
     words a person needs at the moment they hand a role to someone. */
  import * as Select from '$lib/components/ui/select/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { PROJECT_ROLES, type ProjectRole } from '$lib/projects/types';
  import { t } from '$lib/i18n';

  interface Props {
    value: ProjectRole;
    id: string;
  }
  let { value = $bindable(), id }: Props = $props();

  const label = (role: ProjectRole) =>
    role === 'manager'
      ? t('projects.roleManager')
      : role === 'editor'
        ? t('projects.roleEditor')
        : t('projects.roleViewer');
  const hint = (role: ProjectRole) =>
    role === 'manager'
      ? t('projects.roleManagerHint')
      : role === 'editor'
        ? t('projects.roleEditorHint')
        : t('projects.roleViewerHint');
</script>

<div class="space-y-2">
  <Label for={id}>{t('projects.roleLabel')}</Label>
  <Select.Root
    type="single"
    {value}
    onValueChange={(v) => {
      const next = PROJECT_ROLES.find((role) => role === v);
      if (next) value = next;
    }}
  >
    <Select.Trigger {id} class="w-full">{label(value)}</Select.Trigger>
    <Select.Content>
      {#each PROJECT_ROLES as role (role)}
        <Select.Item value={role} label={label(role)}>
          <span class="block">
            <span class="block">{label(role)}</span>
            <span class="block text-xs font-normal text-muted-foreground">{hint(role)}</span>
          </span>
        </Select.Item>
      {/each}
    </Select.Content>
  </Select.Root>
  <!-- said again under the closed field: the choice made stays explained -->
  <p class="text-xs text-muted-foreground">{hint(value)}</p>
</div>
