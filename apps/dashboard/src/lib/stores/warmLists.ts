/**
 * The lists the shell warms once the app is idle (the app layout), so the
 * first visit to their page opens on rows instead of on nothing. Each line is
 * the first-page call of the page that remembers the list under that name:
 * keep the two in step (same name, same call, same limit).
 */
import { api } from '$lib/api';
import { warmList } from './pagedList.svelte';

export function warmLists(): void {
  void warmList('decks', async () => {
    const { presentations, nextCursor } = await api.presentations({});
    return { items: presentations, nextCursor };
  });
  void warmList('members', async () => {
    const { members, nextCursor } = await api.members({});
    return { items: members, nextCursor };
  });
  void warmList('invitations', async () => {
    const { invitations, nextCursor } = await api.invitations({});
    return { items: invitations, nextCursor };
  });
  void warmList('api-keys', async () => {
    const { apiKeys, nextCursor } = await api.apiKeys({});
    return { items: apiKeys, nextCursor };
  });
  void warmList('files', async () => {
    const { files, nextCursor } = await api.files({});
    return { items: files, nextCursor };
  });
}
