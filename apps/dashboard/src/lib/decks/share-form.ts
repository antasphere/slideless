import type { ShareTokenCreate } from '@slideless/contract';

/**
 * The share-link create form's state, as the dialog holds it. Kept apart
 * from the component so the body it sends is a pure function with a unit
 * test (PRDCT-2299): a switch dropped from the payload goes red here, with
 * no browser in the loop.
 */
export interface ShareLinkForm {
  name: string;
  versionMode: 'latest' | 'pinned';
  /** The pinned version as the select holds it (a string); read only when pinned. */
  pinnedVersion: string;
  canAnnotate: boolean;
  canSubmitForms: boolean;
  canDownload: boolean;
  showBar: boolean;
  /** The link remembers its recipient's answers (PRDCT-2328); moot with forms off. */
  remembersResponses: boolean;
  /** Respondents may add files to the form's file fields (PRDCT-2403); moot with forms off. */
  canUploadFiles: boolean;
  /** A badge slot, or 'default' for the deck's own; sent only with annotations on. */
  badgePosition: string;
  /** 'never' or a number of days as a string. */
  expiresIn: string;
  password: string;
}

/** The form's defaults: every capability on except annotations, latest, no expiry. */
export function defaultShareLinkForm(firstVersion: number | null): ShareLinkForm {
  return {
    name: '',
    versionMode: 'latest',
    pinnedVersion: firstVersion === null ? '' : String(firstVersion),
    canAnnotate: false,
    // ON by default — a deck's embedded form is its intended interaction
    // (ADR 022); the toggle is the per-link opt-out.
    canSubmitForms: true,
    // ON by default (PRDCT-2278): files were put in downloads/ to be handed
    // out; the toggle is the per-link opt-out.
    canDownload: true,
    // ON by default (PRDCT-2281): the recipient sees the bar; the toggle is
    // the per-link opt-out.
    showBar: true,
    // ON by default (PRDCT-2328): a link minted for one named recipient IS
    // that person's response; the toggle is the per-link opt-out for a link
    // many people will open.
    remembersResponses: true,
    // ON by default (PRDCT-2403): a file field is the deck's own intended
    // interaction, like the form around it; the toggle is the per-link
    // opt-out.
    canUploadFiles: true,
    badgePosition: 'default',
    expiresIn: 'never',
    password: ''
  };
}

/** The create body, every switch carried explicitly so the server never falls back to a default the person did not choose. */
export function buildShareTokenCreate(form: ShareLinkForm, now: number = Date.now()): ShareTokenCreate {
  return {
    name: form.name,
    versionMode: form.versionMode,
    ...(form.versionMode === 'pinned' ? { pinnedVersion: Number(form.pinnedVersion) } : {}),
    canAnnotate: form.canAnnotate,
    canSubmitForms: form.canSubmitForms,
    canDownload: form.canDownload,
    showBar: form.showBar,
    // Carried explicitly, and OFF when forms are off: a link that refuses
    // submissions has nothing to remember, and the table must not show a
    // remembering check on it.
    remembersResponses: form.canSubmitForms && form.remembersResponses,
    // Same rule (PRDCT-2403): uploads need submissions, so a link with forms
    // off never carries an uploads check, and never opens the public write
    // by a server default the person did not choose.
    canUploadFiles: form.canSubmitForms && form.canUploadFiles,
    ...(form.canAnnotate && form.badgePosition !== 'default'
      ? { badgePosition: form.badgePosition as ShareTokenCreate['badgePosition'] }
      : {}),
    ...(form.expiresIn !== 'never'
      ? { expiresAt: new Date(now + Number(form.expiresIn) * 86_400_000).toISOString() }
      : {}),
    ...(form.password ? { password: form.password } : {})
  };
}
