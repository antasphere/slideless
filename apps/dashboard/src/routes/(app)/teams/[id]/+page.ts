import type { PageLoad } from './$types';

/** A team's own page: every member of the workspace who is not a guest reads it; the page fetches the team itself. */
export const load: PageLoad = ({ params }) => ({ teamId: params.id });
