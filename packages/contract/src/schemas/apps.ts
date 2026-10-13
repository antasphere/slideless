import { z } from 'zod';

/**
 * The Apps page: the other tools of the person's organization, and the
 * account that signs them in. Client-safe (pure zod): the server answers with
 * it, the SDK and the dashboard type against it.
 *
 * Where the list comes from (`source`):
 *  - `hub`: on the cloud edition, the hub asked AS THE PERSON with their own
 *    grant (the tools they have signed in to, kept where the workspace's hub
 *    organization lets them use the tool);
 *  - `file`: the operator's own list (`APPS_FILE`), on a self-hosted
 *    instance or when the hub could not be asked;
 *  - `none`: neither, and the list is empty.
 *
 * Every URL is an http(s) URL the server checked before serving it.
 */

/** One tool the person may open. */
export const appEntrySchema = z.object({
  /** The tool's registry slug (`finance`, `hiring`, …): what picks its drawing and its sentence. */
  slug: z.string(),
  /** The tool's display name. */
  name: z.string(),
  /** Where opening the tool lands. */
  launchUrl: z.string(),
  /** The operator's own sentence for the tool (the file source), else null. */
  description: z.string().nullable(),
  /** The person has signed in to the tool (the hub source); false when nothing says so. */
  connected: z.boolean(),
  /** When the person first signed in to the tool (the hub source), else null. */
  firstUsedAt: z.string().nullable(),
  /** When the person last signed in to the tool (the hub source), else null. */
  lastUsedAt: z.string().nullable(),
  /** This very tool: the page shows it, with no button. */
  current: z.boolean()
});
export type AppEntry = z.infer<typeof appEntrySchema>;

export const APP_SOURCES = ['hub', 'file', 'none'] as const;
export type AppSource = (typeof APP_SOURCES)[number];

/** GET /apps. */
export const appsListSchema = z.object({
  apps: z.array(appEntrySchema),
  /** The account that signs the person in (the hub), when the instance knows one. */
  hub: z.object({ url: z.string(), name: z.string() }).nullable(),
  source: z.enum(APP_SOURCES)
});
export type AppsList = z.infer<typeof appsListSchema>;
