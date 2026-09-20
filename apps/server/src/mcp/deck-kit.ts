import {
  createScopeCheck,
  mergeErrorHints,
  wrapToolErrors as wrapToolErrorsWith,
  type ErrorHints,
  type ToolTextResult
} from '@antasphere/chassis-server/mcp';
import { IDENTITY } from '@slideless/contract';

/**
 * The deck domain's half of the MCP kit: its two scope names and the error
 * hints of its own API codes, bound ONCE so the slideless_ tool set (tools.ts)
 * keeps calling `checkScope(principal, scope)` and `wrapToolErrors(fn)`.
 */
export const DECK_MCP_SCOPES = { read: IDENTITY.scopes.read, write: IDENTITY.scopes.write } as const;

export const DECK_ERROR_HINTS: ErrorHints = {
  // ── Presentation domain (the slideless_ tool set) ──────────────────────────
  not_found:
    'The resource does not exist or this credential cannot read it (deck reads are private — ' +
    'the owner, a workspace admin, an active collaborator, or a member of a project the deck is in). ' +
    'Check the id with slideless_list_presentations.',
  // `project_archived` and `insufficient_project_role` are the chassis' codes
  // and carry the chassis' hints; only the deck-side code is worded here.
  project_not_found:
    'No such project, or this credential cannot read it, or the push named a project it may not link ' +
    'into (editor or more, not archived). List yours with slideless_list_projects.',
  forbidden:
    'This credential lacks the deck-level right for this action (e.g. only the deck owner or a ' +
    'workspace admin can delete/invite). Ask the deck owner to do it or to grant access.',
  version_conflict:
    'Someone committed a new version in between. Re-read the deck (slideless_get_presentation) ' +
    'and retry on top of its currentVersion.',
  missing_blobs:
    'The manifest references content not uploaded to this workspace. Retry the upload tool; if it ' +
    'persists, push with the slideless CLI.',
  invalid_manifest: 'Fix the manifest entries (paths must be relative, no ".." segments) and retry.',
  invalid_version:
    'That version number does not exist on this deck — list them with slideless_list_versions.',
  session_expired: 'The upload session expired — call the upload tool again (it reserves a fresh one).',
  session_consumed: 'This upload session was already committed — start a new upload.',
  token_revoked: 'This share token was revoked — mint a new one with slideless_add_share_token.',
  token_expired: 'This share token expired — extend it or mint a new one with slideless_add_share_token.',
  already_owner: 'The deck owner does not need a collaborator grant — nothing to do.',
  entitlement_denied: 'The workspace quota refused this upload — free space or raise the plan limits.',
  file_too_large: 'One file exceeds the instance upload limit — use the slideless CLI or shrink the file.',
  payload_too_large: 'The request exceeds the 1 MiB MCP body cap — push large decks with the slideless CLI.',
  validation_error: 'The request shape was rejected — fix the listed fields and retry.'
};

/** Tool-level scope pre-check — UX only (the API's fail-closed allowlist enforces). */
export const checkScope = createScopeCheck(DECK_MCP_SCOPES);

const hints = mergeErrorHints(DECK_ERROR_HINTS);

/** `wrapToolErrors` reading the chassis hints AND the deck ones. */
export const wrapToolErrors = (fn: () => Promise<ToolTextResult>): Promise<ToolTextResult> =>
  wrapToolErrorsWith(fn, hints);
