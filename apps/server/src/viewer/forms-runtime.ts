/**
 * The forms runtime client (ADR 022): a single self-contained inline
 * <script> injected into same-deck HTML document AND frame navigations
 * (viewer/inject.ts) for tokens with `can_submit_forms` whose VERSION
 * actually carries a marked form. Vanilla JS + inline CSS, zero external
 * requests — the sandbox CSP allows scripts but the page must stay
 * self-sufficient.
 *
 * It wires every `<form data-slideless-form="name">` the deck author wrote:
 * intercepts submit, serializes FormData to a flat JSON payload, POSTs to
 * the token-session form API (viewer/forms-api.ts), and opens a
 * confirmation DIALOG over the form (PRDCT-2343): the form stays in the
 * page, visible and editable behind a scrim, and the dialog carries the
 * respondent's personal EDIT LINK (the current page URL + `#slr=<edit
 * secret>`) or, on a remembering link, the line saying the link is the
 * handle. Closing the dialog (its close control, Escape, a click on the
 * scrim, [[Edit response]]) leaves the answers in the fields and a one-line
 * status after the form with a control that reopens the same dialog, so
 * nothing the confirmation said is ever unreachable.
 *
 * Every string the dialog speaks comes from ONE language contract
 * (PRDCT-2344): the form's `data-slideless-lang`, else the nearest
 * ancestor's, else the document's `<html lang>`, else English, picks a
 * built-in catalogue; any single string is overridable with
 * `data-slideless-text-<key>` on the form, and `data-slideless-success`
 * keeps its documented meaning as the `success` override. An authored
 * string is TEXT: capped, control characters stripped, assigned only through
 * textContent / placeholder, never parsed as markup; `{date}` is the one
 * placeholder, substituted as text. The key set is closed (the catalogue's
 * keys), so an unknown attribute does nothing, and a language outside the
 * catalogue falls back to English rather than to nothing. The strings
 * render inside the sandboxed viewer document and nowhere else: the server
 * never receives them, the dashboard never renders them.
 *
 * ══ TRUST BOUNDARY — read before adding ANY field to FormsConfig ══
 *
 * The runtime shares the document with untrusted deck JS inside the
 * sandboxed opaque origin (ADR 012), so the invariant is:
 *
 *     every value the server places in the deck document must be one the
 *     deck could already obtain by itself.
 *
 * Two capability-bearing values qualify and are injected: the share-token
 * secret (already in `location.pathname`) and the unlock proof (password
 * links, scoped to viewer calls on this same token). The rest of the config
 * — version, source, placement, emailAvailable, remembers — is server
 * CONTEXT, not capability, and the server re-derives or re-validates each
 * of them at write time. `remembers` (PRDCT-2328) passes the rule the same
 * way emailAvailable does: the deck could learn it by calling the
 * remembered-answers route without any secret (200 or 404), and knowing it
 * grants nothing — the share secret already in the URL is what resolves the
 * remembered row. NOTHING identifying rides here: not an id, not an
 * address, not a handle. That is the whole difference from leg 3.
 *
 * ⚠️ This is a CONSTRAINT ON FUTURE EDITS, not a description of the code.
 * The previous wording here ("the runtime adds NO capability the deck did
 * not have") was a description, and it is precisely what let ADR 022 leg 3
 * through review: leg 3 injected a signed assertion of the SIGNED-IN
 * VIEWER's identity into this config, deck JS lifted it out of
 * `script[data-slideless-forms]`, and responses were filed under a
 * stranger's account across workspaces with no interaction beyond loading
 * the page (PRDCT-1331, audit §1). A reviewer who checked the sentence
 * against the share secret and the unlock proof found it true and stopped
 * reading.
 *
 * So the check is mechanical, not editorial: the injected config's key set
 * is pinned by an integration assertion ("the injected config is a CLOSED
 * set", forms.test.ts), and adding a key turns that test red until someone
 * argues it past the invariant above. Anything that identifies a viewer
 * belongs on the APP origin behind an explicit click — never here.
 *
 * The server re-validates everything regardless: token, capability,
 * password, payload shape/size, rate buckets, per-deck cap.
 *
 *  - Requests go out `credentials: 'omit'` (the Firefox opaque-origin
 *    residual, ADR 012).
 *  - UNLIKE the overlay there is NO `self !== top` refusal: frames are the
 *    embed case, deliberately served (ADR 022; the ADR 021 §1 rationale).
 *  - The dialog's scrim, the status line, the resume prompt AND every
 *    marked form stop event propagation at their root, so clicking a field,
 *    typing a space or pressing Escape in the dialog never drives the
 *    deck's own navigation (PRDCT-1334 item 1: five of five real decks broke
 *    on this). Bubble phase, deliberately: a capture-phase shield on the
 *    form would also kill the AUTHOR's own listeners inside it. Deck
 *    listeners bound with `capture: true` on document still win, as they
 *    always did for the card.
 *  - The dialog is a positioned <div> appended to the body, not a native
 *    <dialog>: the top layer of a sandboxed opaque-origin document is not
 *    something the habitat suite has proven, and a div is proven
 *    (PRDCT-2343).
 *  - An arriving `#slr=` fragment is NEVER silently adopted into update
 *    mode. A framer or a link author controls the fragment, so an attacker
 *    could plant their own empty response's secret and harvest the answers
 *    a stranger typed (PRDCT-1332, audit §2). The runtime shows an explicit
 *    resume prompt and defaults to CREATE. The prompt stays INLINE before
 *    the form, never modal: create is the default, so the respondent must be
 *    able to ignore it and type. The fragment is resolved ONCE per page load
 *    (form-agnostic own-row GET), never once per form: each unresolvable
 *    probe burns the submit bucket, and N forms × reloads was a lockout for
 *    everyone behind one NAT (PRDCT-1331/1334 residual).
 *
 * The config JSON is server-controlled; it is serialized with `<` escaped
 * so a `</script>` sequence can never break out.
 */

export interface FormsConfig {
  /** The deck version this view resolved to — echoed on submissions. */
  version: number;
  /** Signed unlock proof for password-protected tokens (else null). */
  unlock: string | null;
  /** How this document was served: a direct link or an embed frame. */
  source: 'link' | 'embed';
  /** Sanitized `?p=` label of the serving navigation (else null). */
  placement: string | null;
  /** Whether the instance sends email (shows the email-me-my-link opt-in). */
  emailAvailable: boolean;
  /**
   * Whether this link REMEMBERS its answers (PRDCT-2328): on a direct link
   * navigation the runtime prefills each form from the link's own remembered
   * row (no fragment, no secret) and every submit updates it. Inside an
   * embed the runtime ignores it — a website's visitors share the link.
   */
  remembers: boolean;
  /**
   * File fields (PRDCT-2403): whether this link takes uploads, with the two
   * ceilings the drop panel states (bytes per file, files per response).
   * Null = uploads are off here (the link's switch, a preview, or the
   * instance knob) and a file field shows as unavailable. Context, never
   * capability: the upload route re-decides on every request, and both
   * numbers are what a link holder learns from one refused upload.
   */
  uploads: { maxBytes: number; maxFiles: number } | null;
}

/** Attribute marking the injected script — tests and humans grep for it. */
export const FORMS_MARKER = 'data-slideless-forms';

/**
 * The languages the confirmation dialog speaks out of the box (PRDCT-2344),
 * in the order the docs list them. `en` is the fallback for any other tag.
 */
export const FORMS_LANGUAGES = ['en', 'fr', 'nl', 'de', 'es'] as const;

/**
 * The overridable strings, by key: `data-slideless-text-<kebab-key>` on the
 * form (`emailSend` → `data-slideless-text-email-send`). Exported so the docs
 * table and the tests are pinned to the same closed set as the runtime.
 */
export const FORMS_TEXT_KEYS = [
  'success',
  'updated',
  'remembers',
  'keepLink',
  'copy',
  'copied',
  'copyFailed',
  'edit',
  'emailPlaceholder',
  'emailSend',
  'emailSent',
  'emailFailed',
  'emailNote',
  'resumeTitle',
  'resumeWhy',
  'resumeEdit',
  'resumeNew',
  'errorGeneric',
  'errorNetwork',
  'close',
  'show',
  'uploadPrompt',
  'uploadPromptOne',
  'uploadHintTypes',
  'uploadHintSize',
  'uploadHintMax',
  'uploadTooLarge',
  'uploadWrongType',
  'uploadTooMany',
  'uploadRequired',
  'uploadTooFew',
  'uploadFailed',
  'uploadUnavailable',
  'uploadBusy',
  'uploadRemove'
] as const;

/** An authored string longer than this is cut: a dialog, not a page. */
export const FORMS_TEXT_MAX = 1000;

export type FormsLanguage = (typeof FORMS_LANGUAGES)[number];
export type FormsTextKey = (typeof FORMS_TEXT_KEYS)[number];

/**
 * The built-in strings, one complete set per language (a unit test pins
 * completeness, so a key added here without every language turns it red).
 * Serialized into the runtime with `<` escaped, exactly like the config.
 */
export const FORMS_CATALOGUE: Record<FormsLanguage, Record<FormsTextKey, string>> = {
  en: {
    success: 'Your response has been recorded.',
    updated: 'Your response has been updated.',
    remembers: 'This link remembers your answers: reopen it any time to view or change them.',
    keepLink: 'Keep this personal link to view or update your answer later:',
    copy: 'Copy link',
    copied: 'Copied',
    copyFailed: 'Press Ctrl+C',
    edit: 'Edit response',
    emailPlaceholder: 'you@example.com',
    emailSend: 'Email me my link',
    emailSent: 'Sent',
    emailFailed: 'Try again later',
    emailNote: 'Optional: get the link by email so you can come back to it.',
    resumeTitle: 'This link points at a response submitted on {date}.',
    resumeWhy:
      'Choose "Edit that response" only if it is yours: editing replaces its answers. Otherwise submit a new response.',
    resumeEdit: 'Edit that response',
    resumeNew: 'Submit a new response',
    errorGeneric: 'Something went wrong. Please try again.',
    errorNetwork: 'Network error. Please try again.',
    close: 'Close',
    show: 'Show confirmation',
    uploadPrompt: 'Drop files here, or click to choose',
    uploadPromptOne: 'Drop a file here, or click to choose',
    uploadHintTypes: 'Accepted: {types}',
    uploadHintSize: 'Up to {size} per file',
    uploadHintMax: '{max} files at most',
    uploadTooLarge: '{name} is larger than {size}.',
    uploadWrongType: '{name} is not an accepted type ({types}).',
    uploadTooMany: 'You can add at most {max} files here.',
    uploadRequired: 'Please add a file.',
    uploadTooFew: 'Please add at least {min} files.',
    uploadFailed: '{name} could not be uploaded. Please try again.',
    uploadUnavailable: 'File upload is not available on this link.',
    uploadBusy: 'Please wait for the uploads to finish.',
    uploadRemove: 'Remove'
  },
  fr: {
    success: 'Votre réponse a bien été enregistrée.',
    updated: 'Votre réponse a été mise à jour.',
    remembers: 'Ce lien retient vos réponses : rouvrez-le à tout moment pour les consulter ou les modifier.',
    keepLink: 'Conservez ce lien personnel pour consulter ou modifier votre réponse plus tard :',
    copy: 'Copier le lien',
    copied: 'Copié',
    copyFailed: 'Appuyez sur Ctrl+C',
    edit: 'Modifier ma réponse',
    emailPlaceholder: 'vous@exemple.be',
    emailSend: 'Recevoir mon lien par e-mail',
    emailSent: 'Envoyé',
    emailFailed: 'Réessayez plus tard',
    emailNote: 'Facultatif : recevez le lien par e-mail pour pouvoir y revenir.',
    resumeTitle: 'Ce lien renvoie à une réponse envoyée le {date}.',
    resumeWhy:
      'Choisissez « Modifier cette réponse » uniquement si elle est la vôtre : la modification remplace ses réponses. Sinon, envoyez une nouvelle réponse.',
    resumeEdit: 'Modifier cette réponse',
    resumeNew: 'Envoyer une nouvelle réponse',
    errorGeneric: 'Une erreur est survenue. Veuillez réessayer.',
    errorNetwork: 'Erreur réseau. Veuillez réessayer.',
    close: 'Fermer',
    show: 'Afficher la confirmation',
    uploadPrompt: 'Déposez des fichiers ici, ou cliquez pour les choisir',
    uploadPromptOne: 'Déposez un fichier ici, ou cliquez pour le choisir',
    uploadHintTypes: 'Formats acceptés : {types}',
    uploadHintSize: '{size} maximum par fichier',
    uploadHintMax: '{max} fichiers au maximum',
    uploadTooLarge: '{name} dépasse {size}.',
    uploadWrongType: "{name} n'est pas d'un format accepté ({types}).",
    uploadTooMany: 'Vous pouvez ajouter {max} fichiers au maximum ici.',
    uploadRequired: 'Veuillez ajouter un fichier.',
    uploadTooFew: 'Veuillez ajouter au moins {min} fichiers.',
    uploadFailed: "{name} n'a pas pu être envoyé. Veuillez réessayer.",
    uploadUnavailable: "L'envoi de fichiers n'est pas disponible sur ce lien.",
    uploadBusy: "Veuillez attendre la fin de l'envoi des fichiers.",
    uploadRemove: 'Retirer'
  },
  nl: {
    success: 'Uw antwoord is opgeslagen.',
    updated: 'Uw antwoord is bijgewerkt.',
    remembers:
      'Deze link onthoudt uw antwoorden: open hem op elk moment opnieuw om ze te bekijken of te wijzigen.',
    keepLink: 'Bewaar deze persoonlijke link om uw antwoord later te bekijken of te wijzigen:',
    copy: 'Link kopiëren',
    copied: 'Gekopieerd',
    copyFailed: 'Druk op Ctrl+C',
    edit: 'Antwoord wijzigen',
    emailPlaceholder: 'u@voorbeeld.be',
    emailSend: 'Stuur mij mijn link per e-mail',
    emailSent: 'Verzonden',
    emailFailed: 'Probeer het later opnieuw',
    emailNote: 'Optioneel: ontvang de link per e-mail zodat u er later naar terug kunt.',
    resumeTitle: 'Deze link verwijst naar een antwoord dat is verzonden op {date}.',
    resumeWhy:
      'Kies "Dat antwoord wijzigen" alleen als het van u is: wijzigen vervangt de antwoorden. Verzend anders een nieuw antwoord.',
    resumeEdit: 'Dat antwoord wijzigen',
    resumeNew: 'Een nieuw antwoord verzenden',
    errorGeneric: 'Er is iets misgegaan. Probeer het opnieuw.',
    errorNetwork: 'Netwerkfout. Probeer het opnieuw.',
    close: 'Sluiten',
    show: 'Bevestiging tonen',
    uploadPrompt: 'Sleep bestanden hierheen, of klik om ze te kiezen',
    uploadPromptOne: 'Sleep een bestand hierheen, of klik om het te kiezen',
    uploadHintTypes: 'Toegestaan: {types}',
    uploadHintSize: 'Maximaal {size} per bestand',
    uploadHintMax: 'Maximaal {max} bestanden',
    uploadTooLarge: '{name} is groter dan {size}.',
    uploadWrongType: '{name} is geen toegestaan type ({types}).',
    uploadTooMany: 'U kunt hier maximaal {max} bestanden toevoegen.',
    uploadRequired: 'Voeg een bestand toe.',
    uploadTooFew: 'Voeg minstens {min} bestanden toe.',
    uploadFailed: '{name} kon niet worden geüpload. Probeer het opnieuw.',
    uploadUnavailable: 'Bestanden uploaden is niet beschikbaar op deze link.',
    uploadBusy: 'Wacht tot de uploads klaar zijn.',
    uploadRemove: 'Verwijderen'
  },
  de: {
    success: 'Ihre Antwort wurde gespeichert.',
    updated: 'Ihre Antwort wurde aktualisiert.',
    remembers:
      'Dieser Link merkt sich Ihre Antworten: Öffnen Sie ihn jederzeit erneut, um sie anzusehen oder zu ändern.',
    keepLink: 'Bewahren Sie diesen persönlichen Link auf, um Ihre Antwort später anzusehen oder zu ändern:',
    copy: 'Link kopieren',
    copied: 'Kopiert',
    copyFailed: 'Drücken Sie Strg+C',
    edit: 'Antwort bearbeiten',
    emailPlaceholder: 'sie@beispiel.de',
    emailSend: 'Link per E-Mail senden',
    emailSent: 'Gesendet',
    emailFailed: 'Später erneut versuchen',
    emailNote: 'Optional: Erhalten Sie den Link per E-Mail, um später darauf zurückzukommen.',
    resumeTitle: 'Dieser Link verweist auf eine Antwort, die am {date} gesendet wurde.',
    resumeWhy:
      'Wählen Sie „Diese Antwort bearbeiten“ nur, wenn es Ihre eigene ist: Das Bearbeiten ersetzt ihre Antworten. Senden Sie andernfalls eine neue Antwort.',
    resumeEdit: 'Diese Antwort bearbeiten',
    resumeNew: 'Neue Antwort senden',
    errorGeneric: 'Etwas ist schiefgelaufen. Bitte versuchen Sie es erneut.',
    errorNetwork: 'Netzwerkfehler. Bitte versuchen Sie es erneut.',
    close: 'Schließen',
    show: 'Bestätigung anzeigen',
    uploadPrompt: 'Dateien hier ablegen oder klicken, um sie auszuwählen',
    uploadPromptOne: 'Datei hier ablegen oder klicken, um sie auszuwählen',
    uploadHintTypes: 'Erlaubt: {types}',
    uploadHintSize: 'Bis zu {size} pro Datei',
    uploadHintMax: 'Höchstens {max} Dateien',
    uploadTooLarge: '{name} ist größer als {size}.',
    uploadWrongType: '{name} hat keinen erlaubten Typ ({types}).',
    uploadTooMany: 'Sie können hier höchstens {max} Dateien hinzufügen.',
    uploadRequired: 'Bitte fügen Sie eine Datei hinzu.',
    uploadTooFew: 'Bitte fügen Sie mindestens {min} Dateien hinzu.',
    uploadFailed: '{name} konnte nicht hochgeladen werden. Bitte versuchen Sie es erneut.',
    uploadUnavailable: 'Das Hochladen von Dateien ist über diesen Link nicht möglich.',
    uploadBusy: 'Bitte warten Sie, bis die Uploads abgeschlossen sind.',
    uploadRemove: 'Entfernen'
  },
  es: {
    success: 'Su respuesta ha sido registrada.',
    updated: 'Su respuesta ha sido actualizada.',
    remembers:
      'Este enlace recuerda sus respuestas: vuelva a abrirlo en cualquier momento para verlas o cambiarlas.',
    keepLink: 'Guarde este enlace personal para ver o actualizar su respuesta más tarde:',
    copy: 'Copiar enlace',
    copied: 'Copiado',
    copyFailed: 'Pulse Ctrl+C',
    edit: 'Editar respuesta',
    emailPlaceholder: 'usted@ejemplo.es',
    emailSend: 'Enviarme mi enlace por correo',
    emailSent: 'Enviado',
    emailFailed: 'Inténtelo más tarde',
    emailNote: 'Opcional: reciba el enlace por correo para poder volver más tarde.',
    resumeTitle: 'Este enlace apunta a una respuesta enviada el {date}.',
    resumeWhy:
      'Elija «Editar esa respuesta» solo si es suya: editar reemplaza sus respuestas. Si no, envíe una nueva respuesta.',
    resumeEdit: 'Editar esa respuesta',
    resumeNew: 'Enviar una nueva respuesta',
    errorGeneric: 'Algo ha fallado. Vuelva a intentarlo.',
    errorNetwork: 'Error de red. Vuelva a intentarlo.',
    close: 'Cerrar',
    show: 'Mostrar la confirmación',
    uploadPrompt: 'Suelte archivos aquí, o haga clic para elegirlos',
    uploadPromptOne: 'Suelte un archivo aquí, o haga clic para elegirlo',
    uploadHintTypes: 'Aceptados: {types}',
    uploadHintSize: 'Hasta {size} por archivo',
    uploadHintMax: '{max} archivos como máximo',
    uploadTooLarge: '{name} supera {size}.',
    uploadWrongType: '{name} no es de un tipo aceptado ({types}).',
    uploadTooMany: 'Puede añadir {max} archivos como máximo aquí.',
    uploadRequired: 'Añada un archivo.',
    uploadTooFew: 'Añada al menos {min} archivos.',
    uploadFailed: '{name} no se ha podido subir. Vuelva a intentarlo.',
    uploadUnavailable: 'La subida de archivos no está disponible en este enlace.',
    uploadBusy: 'Espere a que terminen las subidas.',
    uploadRemove: 'Quitar'
  }
};

const FORMS_JS = String.raw`
var doc = document;
if (!doc || !doc.documentElement) return;
// Never mount twice (a deck could re-run injected scripts). No top-context
// requirement: frames are the embed case and are served on purpose.
if (window.__slidelessFormsLoaded) return;
window.__slidelessFormsLoaded = true;
var fetchFn = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
if (!fetchFn) return;

var SELECTOR = 'form[data-slideless-form]';

// ---- URL model ---------------------------------------------------------
// The viewer serves the deck under /v/{secret}[/{path}]. The RAW (still
// percent-encoded) secret segment authenticates API calls; the personal
// edit link is THIS page's URL plus the fragment secret.
var rawSecret, apiBase;
var seg = location.pathname.split('/');
if (seg[1] !== 'v' || !seg[2]) return;
rawSecret = seg[2];
apiBase = new URL('/api/v1/viewer/' + rawSecret + '/forms', location.href).toString();

function formApi(form, suffix) {
  return apiBase + '/' + encodeURIComponent(form.getAttribute('data-slideless-form')) + suffix;
}

// ---- the arriving fragment secret --------------------------------------
// Read from the EARLY stub when present (viewer/inject.ts stamps
// window.__slidelessArrivalHash right after <head>, before any deck script)
// — decks that run history.replaceState(null,'','#slide=1') would otherwise
// have wiped it before this script ever runs (PRDCT-1334 item 4).
var arrivalHash = typeof window.__slidelessArrivalHash === 'string'
  ? window.__slidelessArrivalHash
  : (location.hash || '');
var fragMatch = /[#&]slr=([A-Za-z0-9_-]{20,128})/.exec(arrivalHash);
// The fragment secret is a CANDIDATE, never an adopted identity: it belongs
// to whoever wrote the link, who may not be the person now filling the form.
var candidateSecret = fragMatch ? fragMatch[1] : null;

function headers(secret) {
  var h = { 'content-type': 'application/json' };
  if (CFG.unlock) h['x-slideless-unlock'] = CFG.unlock;
  if (secret) h['x-slideless-response'] = secret;
  return h;
}

// ---- the language contract (PRDCT-2344) --------------------------------
// One catalogue (CATALOGUE, serialized above from FORMS_CATALOGUE), one
// language per form, every string overridable one by one. The author sets
// the language ONCE (data-slideless-lang on the form or an ancestor, else
// the document's own lang), so a French deck stays French after the submit
// without knowing a single attribute name; a language the catalogue lacks
// falls back to English, never to nothing.
var hasOwn = Object.prototype.hasOwnProperty;

// The form's own attribute, then the nearest ancestor's, then the document's
// lang; only the primary subtag counts (fr-BE is fr), lowercased; anything
// the catalogue lacks is English. The value is a KEY into the catalogue and
// nothing else ever happens with it.
function langOf(form) {
  var el = form, v = null;
  while (el && el.getAttribute) {
    v = el.getAttribute('data-slideless-lang');
    if (v) break;
    el = el.parentNode;
  }
  if (!v) v = doc.documentElement.getAttribute('lang') || '';
  v = String(v).trim().toLowerCase().split(/[-_]/)[0];
  return hasOwn.call(CATALOGUE, v) ? v : 'en';
}

// An authored string is text: control characters out, whitespace trimmed,
// length capped. It is only ever assigned through textContent or a
// placeholder property, so markup in it renders as the characters typed.
function cleanText(v) {
  if (typeof v !== 'string') return null;
  v = v.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
  if (!v) return null;
  return v.length > TEXT_MAX ? v.slice(0, TEXT_MAX) : v;
}

function kebab(key) {
  return key.replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); });
}

// text(form, key[, vars]): the author's override for that key if any
// (data-slideless-text-<key>; data-slideless-success is the documented alias
// of the success key), else the catalogue in the form's language, else
// English. {name} placeholders are replaced by the vars given, as text.
function text(form, key, vars) {
  if (!form.__slLang) form.__slLang = langOf(form);
  var own = form.getAttribute('data-slideless-text-' + kebab(key));
  if (own == null && key === 'success') own = form.getAttribute('data-slideless-success');
  var v = cleanText(own);
  if (v == null) v = CATALOGUE[form.__slLang][key];
  if (v == null) v = CATALOGUE.en[key];
  if (vars) {
    v = v.replace(/\{(\w+)\}/g, function (m, k) {
      return hasOwn.call(vars, k) ? String(vars[k]) : m;
    });
  }
  return v;
}

// ---- styles ------------------------------------------------------------
var style = doc.createElement('style');
style.textContent =
  '.sl-forms-card{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;' +
  'background:#fff;color:#18181b;border:1px solid #e4e4e7;border-radius:10px;padding:16px;' +
  'margin:8px 0;font-size:14px;line-height:1.5;box-shadow:0 1px 3px rgba(0,0,0,.06);text-align:left}' +
  '.sl-forms-card p{margin:0 0 10px}' +
  '.sl-forms-ok{font-weight:600}' +
  '.sl-forms-link{word-break:break-all;font-size:12px;color:#3f3f46;background:#f4f4f5;' +
  'border-radius:6px;padding:6px 8px;display:block;margin:0 0 10px}' +
  '.sl-forms-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}' +
  '.sl-forms-btn{background:#18181b;color:#fff;border:0;border-radius:7px;padding:7px 12px;' +
  'font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}' +
  '.sl-forms-btn-2{background:#fff;color:#18181b;border:1px solid #d4d4d8;border-radius:7px;' +
  'padding:7px 12px;font-size:13px;cursor:pointer;font-family:inherit}' +
  '.sl-forms-mail{flex:1;min-width:160px;box-sizing:border-box;padding:7px 10px;' +
  'border:1px solid #d4d4d8;border-radius:7px;font-size:13px;font-family:inherit}' +
  '.sl-forms-err{color:#dc2626;font-size:13px;margin:6px 0 0}' +
  '.sl-forms-note{color:#52525b;font-size:12px;margin:6px 0 0}' +
  // The dialog (PRDCT-2343): a fixed scrim over the whole viewport, the box
  // centred in it. Appended to the body so a transformed slide never
  // becomes its containing block; the z-index is the maximum so no deck
  // chrome sits above it.
  '.sl-forms-scrim{position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;' +
  'background:rgba(24,24,27,.45);display:flex;align-items:center;justify-content:center;' +
  'padding:16px;box-sizing:border-box}' +
  '.sl-forms-dialog{position:relative;width:100%;max-width:480px;max-height:calc(100vh - 32px);' +
  'overflow:auto;margin:0;padding-right:40px;box-shadow:0 20px 60px rgba(0,0,0,.3);outline:none}' +
  '.sl-forms-x{position:absolute;top:8px;right:8px;width:28px;height:28px;border:0;' +
  'background:transparent;color:#71717a;font-size:20px;line-height:28px;cursor:pointer;' +
  'border-radius:6px;padding:0;font-family:inherit}' +
  '.sl-forms-x:hover,.sl-forms-x:focus{background:#f4f4f5;color:#18181b;outline:none}' +
  // The status line left after the form once the dialog is closed.
  '.sl-forms-status{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;' +
  'font-size:13px;color:#3f3f46;margin:8px 0;display:flex;gap:8px;flex-wrap:wrap;' +
  'align-items:center;text-align:left}' +
  '.sl-forms-status .sl-forms-btn-2{padding:4px 10px;font-size:12px}' +
  '.sl-forms-status-floating{position:fixed;left:12px;bottom:12px;z-index:2147483646;' +
  'background:#fff;border:1px solid #e4e4e7;border-radius:8px;padding:8px 10px;margin:0;' +
  'box-shadow:0 4px 16px rgba(0,0,0,.15);max-width:calc(100vw - 24px);box-sizing:border-box}' +
  // The file field's drop panel (PRDCT-2403). The author's own input stays
  // in the DOM, visually hidden: it is what opens the system file picker.
  '.sl-forms-file-hidden{position:absolute!important;width:1px!important;height:1px!important;' +
  'opacity:0!important;overflow:hidden!important;clip:rect(0 0 0 0)!important;pointer-events:none!important}' +
  '.sl-forms-drop{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;' +
  'border:2px dashed #d4d4d8;border-radius:10px;background:#fafafa;color:#3f3f46;' +
  'padding:18px 14px;margin:6px 0;text-align:center;cursor:pointer;font-size:14px;line-height:1.45;' +
  'transition:border-color .12s,background .12s;box-sizing:border-box;outline:none}' +
  '.sl-forms-drop:hover,.sl-forms-drop:focus{border-color:#a1a1aa;background:#f4f4f5}' +
  '.sl-forms-drop-armed{border-color:#71717a;background:#f4f4f5}' +
  '.sl-forms-drop-over{border-color:#18181b;background:#e4e4e7}' +
  '.sl-forms-drop-off{cursor:not-allowed;opacity:.65}' +
  '.sl-forms-drop-prompt{font-weight:600;color:#18181b}' +
  '.sl-forms-drop-hint{font-size:12px;color:#71717a;margin-top:4px}' +
  '.sl-forms-files{list-style:none;margin:6px 0;padding:0;font-family:-apple-system,Segoe UI,Roboto,' +
  'Helvetica,Arial,sans-serif;font-size:13px;color:#18181b;text-align:left}' +
  '.sl-forms-file{position:relative;display:flex;gap:8px;align-items:center;border:1px solid #e4e4e7;' +
  'border-radius:8px;background:#fff;padding:7px 10px;margin:4px 0;overflow:hidden}' +
  '.sl-forms-file-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
  '.sl-forms-file-size{color:#71717a;font-size:12px;white-space:nowrap}' +
  '.sl-forms-file-bar{position:absolute;left:0;bottom:0;height:3px;width:0;background:#18181b;' +
  'transition:width .15s}' +
  '.sl-forms-file-err{border-color:#fca5a5;background:#fef2f2}' +
  '.sl-forms-file-err .sl-forms-file-size{color:#dc2626;white-space:normal}' +
  '.sl-forms-file-x{border:0;background:transparent;color:#71717a;cursor:pointer;font-size:12px;' +
  'padding:2px 6px;border-radius:6px;font-family:inherit}' +
  '.sl-forms-file-x:hover,.sl-forms-file-x:focus{background:#f4f4f5;color:#18181b;outline:none}';
doc.documentElement.appendChild(style);

// ---- deck-handler shield -----------------------------------------------
// Every real deck binds document-level keydown/click navigation. Without
// this, clicking a field flips the slide, space is swallowed mid-word, and
// submitting navigates away from the confirmation.
var SHIELDED = ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup',
  'touchstart', 'touchend', 'wheel', 'keydown', 'keyup', 'keypress'];
function shield(el) {
  if (el.__slShielded) return;
  el.__slShielded = true;
  for (var i = 0; i < SHIELDED.length; i++) {
    el.addEventListener(SHIELDED[i], function (e) { e.stopPropagation(); });
  }
}

// ---- payload serialization --------------------------------------------
// FormData -> flat { name: string | string[] }. File values are skipped
// HERE: a file field's files travel on their own requests and the submit
// names them (the file fields section below). Repeated names accumulate
// into arrays — the server validates shape and size, never meaning.
function serialize(form) {
  var out = {};
  var fd = new FormData(form);
  fd.forEach(function (value, key) {
    if (typeof value !== 'string') return;
    if (hasOwn.call(out, key)) {
      if (Array.isArray(out[key])) out[key].push(value);
      else out[key] = [out[key], value];
    } else {
      out[key] = value;
    }
  });
  return out;
}

// ---- prefill -----------------------------------------------------------
function prefill(form, payload) {
  Object.keys(payload).forEach(function (key) {
    var value = payload[key];
    var values = Array.isArray(value) ? value : [value];
    var fields = form.querySelectorAll('[name]');
    for (var i = 0; i < fields.length; i++) {
      var el = fields[i];
      if (el.name !== key) continue;
      var type = (el.getAttribute('type') || '').toLowerCase();
      if (type === 'checkbox' || type === 'radio') {
        el.checked = values.indexOf(el.value) !== -1;
      } else if (el.tagName === 'SELECT' && el.multiple) {
        for (var j = 0; j < el.options.length; j++) {
          el.options[j].selected = values.indexOf(el.options[j].value) !== -1;
        }
      } else if (type !== 'file') {
        el.value = values[0] != null ? values[0] : '';
      }
    }
  });
}

// ---- file fields (PRDCT-2403) -------------------------------------------
// A plain <input type="file" name="..."> inside a marked form becomes a drop
// panel: drop files on it, or click it for the system file picker. The
// author's constraints are read off the input: accept (extensions such as
// .pdf, or media types such as image/*), required (at least one file),
// multiple (more than one), data-slideless-min / data-slideless-max (the
// count) and data-slideless-max-mb (a size ceiling under the instance's).
// They are enforced HERE, like required on a text field; the server holds
// the instance's ceilings and never reads a form's markup.
//
// A file uploads the moment it is added (one request per file, with a
// progress bar) and the submit then NAMES the uploaded files. The state is
// keyed by FORM NAME + FIELD NAME, the same discriminators the server binds
// an upload to, and lives outside the elements: a deck that rebuilds its
// slide gets the same files back on the new input (the dialog lane's
// lesson), and two forms on one page can never see each other's files.
var UPLOADS = {};
var UP_SEQ = 0;

function upState(form, input) {
  var key = form.getAttribute('data-slideless-form') + '\n' + input.name;
  if (!hasOwn.call(UPLOADS, key)) UPLOADS[key] = { files: [], message: null, input: null, form: null };
  return UPLOADS[key];
}

function fileInputs(form) {
  var all = form.querySelectorAll('input[type="file"][name]');
  var out = [];
  for (var i = 0; i < all.length; i++) if (all[i].name) out.push(all[i]);
  return out;
}

function intAttr(el, name) {
  var v = el.getAttribute(name);
  if (v == null || !/^\d{1,7}$/.test(v.trim())) return null;
  return parseInt(v.trim(), 10);
}

// The field's rules, read once per mount. No max set on a multiple field =
// the instance's own ceiling, which is the "no real upper limit" case.
function upRules(input) {
  var ceiling = CFG.uploads ? CFG.uploads.maxFiles : 0;
  var min = intAttr(input, 'data-slideless-min');
  if (min == null) min = input.__slRequired ? 1 : 0;
  var max = intAttr(input, 'data-slideless-max');
  if (max == null) max = input.multiple ? ceiling : 1;
  if (max < 1) max = 1;
  if (max > ceiling && ceiling > 0) max = ceiling;
  if (min > max) min = max;
  var maxBytes = CFG.uploads ? CFG.uploads.maxBytes : 0;
  var ownMb = intAttr(input, 'data-slideless-max-mb');
  if (ownMb != null && ownMb > 0 && ownMb * 1048576 < maxBytes) maxBytes = ownMb * 1048576;
  var accept = [];
  var raw = (input.getAttribute('accept') || '').split(',');
  for (var i = 0; i < raw.length; i++) {
    var t = raw[i].trim().toLowerCase();
    if (t) accept.push(t);
  }
  return { min: min, max: max, maxBytes: maxBytes, accept: accept };
}

function accepts(rules, file) {
  if (!rules.accept.length) return true;
  var name = String(file.name || '').toLowerCase();
  var type = String(file.type || '').toLowerCase();
  for (var i = 0; i < rules.accept.length; i++) {
    var t = rules.accept[i];
    if (t.charAt(0) === '.') {
      if (name.length > t.length && name.slice(-t.length) === t) return true;
    } else if (t.slice(-2) === '/*') {
      if (type && type.indexOf(t.slice(0, -1)) === 0) return true;
    } else if (type === t) return true;
  }
  return false;
}

function fmtSize(bytes) {
  if (bytes >= 1073741824) return (Math.round(bytes / 107374182.4) / 10) + ' GB';
  if (bytes >= 1048576) return (Math.round(bytes / 104857.6) / 10) + ' MB';
  if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
  return bytes + ' B';
}

function liveCount(state) {
  var n = 0;
  for (var i = 0; i < state.files.length; i++) if (state.files[i].state !== 'error') n++;
  return n;
}

function mountUploads(form) {
  var inputs = fileInputs(form);
  for (var i = 0; i < inputs.length; i++) mountUpload(form, inputs[i]);
}

function mountUpload(form, input) {
  if (input.__slDrop) return;
  // A hidden required control blocks the native submit before any event
  // fires ("not focusable"): the rule moves to the runtime's own check.
  input.__slRequired = input.required === true;
  input.required = false;
  var state = upState(form, input);
  state.input = input;
  state.form = form;
  var rules = upRules(input);
  var off = !CFG.uploads;

  var panel = doc.createElement('div');
  panel.className = 'sl-forms-drop' + (off ? ' sl-forms-drop-off' : '');
  panel.setAttribute('data-slideless-drop', input.name);
  panel.setAttribute('role', 'button');
  panel.tabIndex = off ? -1 : 0;
  if (off) panel.setAttribute('aria-disabled', 'true');
  var prompt = doc.createElement('div');
  prompt.className = 'sl-forms-drop-prompt';
  prompt.textContent = off ? text(form, 'uploadUnavailable')
    : text(form, rules.max === 1 ? 'uploadPromptOne' : 'uploadPrompt');
  panel.appendChild(prompt);
  if (!off) {
    var bits = [];
    if (rules.accept.length) bits.push(text(form, 'uploadHintTypes', { types: rules.accept.join(', ') }));
    bits.push(text(form, 'uploadHintSize', { size: fmtSize(rules.maxBytes) }));
    if (rules.max > 1 && intAttr(input, 'data-slideless-max') != null) {
      bits.push(text(form, 'uploadHintMax', { max: rules.max }));
    }
    var hint = doc.createElement('div');
    hint.className = 'sl-forms-drop-hint';
    hint.textContent = bits.join(' · ');
    panel.appendChild(hint);
  }
  var list = doc.createElement('ul');
  list.className = 'sl-forms-files';
  list.setAttribute('data-slideless-files', input.name);
  var msg = doc.createElement('p');
  msg.className = 'sl-forms-err';
  msg.setAttribute('role', 'alert');
  msg.style.display = 'none';

  input.className = (input.className ? input.className + ' ' : '') + 'sl-forms-file-hidden';
  input.tabIndex = -1;
  input.setAttribute('aria-hidden', 'true');
  var after = input.nextSibling;
  input.parentNode.insertBefore(panel, after);
  input.parentNode.insertBefore(list, after);
  input.parentNode.insertBefore(msg, after);
  input.__slDrop = { panel: panel, list: list, msg: msg, rules: rules };

  if (!off) {
    // preventDefault: inside a <label>, the click would ALSO activate the
    // input natively and open the picker twice.
    panel.addEventListener('click', function (e) { e.preventDefault(); input.click(); });
    panel.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
    });
    input.addEventListener('change', function () {
      if (input.files && input.files.length) addFiles(form, input, input.files);
      // So the same file can be chosen again after a removal.
      try { input.value = ''; } catch (e) { /* read-only in some engines */ }
    });
    panel.addEventListener('dragenter', function (e) { if (hasFiles(e)) { stop(e); panel.classList.add('sl-forms-drop-over'); } });
    panel.addEventListener('dragover', function (e) { if (hasFiles(e)) { stop(e); panel.classList.add('sl-forms-drop-over'); } });
    panel.addEventListener('dragleave', function (e) { stop(e); panel.classList.remove('sl-forms-drop-over'); });
    panel.addEventListener('drop', function (e) {
      if (!hasFiles(e)) return;
      stop(e);
      disarm();
      addFiles(form, input, e.dataTransfer.files);
    });
  }
  renderFiles(state);
}

function stop(e) { e.preventDefault(); e.stopPropagation(); }

function hasFiles(e) {
  var dt = e.dataTransfer;
  if (!dt || !dt.types) return false;
  for (var i = 0; i < dt.types.length; i++) if (dt.types[i] === 'Files') return true;
  return false;
}

// A file dragged anywhere over the page arms every panel on screen, and a
// drop that misses is never the browser's: it would navigate the tab to the
// file and lose the answers typed so far. With exactly ONE panel on screen
// the whole page is its drop target.
function visiblePanels() {
  var all = doc.querySelectorAll('.sl-forms-drop');
  var out = [];
  for (var i = 0; i < all.length; i++) {
    if (all[i].offsetParent !== null && all[i].className.indexOf('sl-forms-drop-off') === -1) out.push(all[i]);
  }
  return out;
}
function disarm() {
  var all = doc.querySelectorAll('.sl-forms-drop');
  for (var i = 0; i < all.length; i++) all[i].classList.remove('sl-forms-drop-armed', 'sl-forms-drop-over');
}
var armTimer = null;
doc.addEventListener('dragover', function (e) {
  if (!hasFiles(e) || !doc.querySelector('.sl-forms-drop')) return;
  e.preventDefault();
  var panels = visiblePanels();
  for (var i = 0; i < panels.length; i++) panels[i].classList.add('sl-forms-drop-armed');
  // dragleave is unreliable at the document level: disarm when the
  // dragover stream stops.
  if (armTimer) clearTimeout(armTimer);
  armTimer = setTimeout(disarm, 250);
});
doc.addEventListener('drop', function (e) {
  if (!hasFiles(e) || !doc.querySelector('.sl-forms-drop')) return;
  e.preventDefault();
  disarm();
  var panels = visiblePanels();
  if (panels.length !== 1) return;
  var name = panels[0].getAttribute('data-slideless-drop');
  for (var key in UPLOADS) {
    if (!hasOwn.call(UPLOADS, key)) continue;
    var st = UPLOADS[key];
    if (st.input && st.input.__slDrop && st.input.__slDrop.panel === panels[0] && st.input.name === name) {
      addFiles(st.form, st.input, e.dataTransfer.files);
      return;
    }
  }
});

function setFieldMessage(state, message) {
  state.message = message;
  var drop = state.input && state.input.__slDrop;
  if (!drop) return;
  drop.msg.textContent = message || '';
  drop.msg.style.display = message ? '' : 'none';
}

function addFiles(form, input, fileList) {
  var state = upState(form, input);
  var rules = input.__slDrop.rules;
  setFieldMessage(state, null);
  var incoming = [];
  for (var i = 0; i < fileList.length; i++) incoming.push(fileList[i]);
  if (!incoming.length) return;
  // A single-file field: the new file replaces the one in place.
  if (rules.max === 1) {
    incoming = [incoming[0]];
    while (state.files.length) removeFile(state, state.files[0]);
  }
  for (var j = 0; j < incoming.length; j++) {
    var file = incoming[j];
    if (liveCount(state) >= rules.max) {
      setFieldMessage(state, text(form, 'uploadTooMany', { max: rules.max }));
      break;
    }
    if (!accepts(rules, file)) {
      setFieldMessage(state, text(form, 'uploadWrongType', { name: file.name, types: rules.accept.join(', ') }));
      continue;
    }
    if (file.size > rules.maxBytes) {
      setFieldMessage(state, text(form, 'uploadTooLarge', { name: file.name, size: fmtSize(rules.maxBytes) }));
      continue;
    }
    startUpload(form, input, state, file);
  }
  renderFiles(state);
}

function startUpload(form, input, state, file) {
  var entry = { key: ++UP_SEQ, id: null, name: String(file.name || 'file'), size: file.size,
    state: 'uploading', progress: 0, attached: false, xhr: null, error: null };
  state.files.push(entry);
  var xhr = new XMLHttpRequest();
  entry.xhr = xhr;
  xhr.open('POST', formApi(form, '/uploads') +
    '?field=' + encodeURIComponent(input.name) +
    '&name=' + encodeURIComponent(entry.name) +
    '&type=' + encodeURIComponent(file.type || ''));
  xhr.withCredentials = false;
  // ALWAYS octet-stream, whatever the file is: the body is a file, never a
  // document the server parses. The file's own type rides the query.
  xhr.setRequestHeader('content-type', 'application/octet-stream');
  if (CFG.unlock) xhr.setRequestHeader('x-slideless-unlock', CFG.unlock);
  xhr.upload.onprogress = function (e) {
    if (e.lengthComputable && e.total > 0) { entry.progress = e.loaded / e.total; paintProgress(entry); }
  };
  function fail(code) {
    entry.state = 'error';
    entry.xhr = null;
    entry.error = code === 'file_too_large'
      ? text(form, 'uploadTooLarge', { name: entry.name, size: fmtSize(input.__slDrop ? input.__slDrop.rules.maxBytes : file.size) })
      : code === 'uploads_disabled' ? text(form, 'uploadUnavailable')
      : text(form, 'uploadFailed', { name: entry.name });
    renderFiles(state);
  }
  xhr.onload = function () {
    var data = null;
    try { data = JSON.parse(xhr.responseText); } catch (e) { data = null; }
    if (xhr.status === 201 && data && data.file && data.file.id) {
      entry.id = data.file.id;
      entry.state = 'done';
      entry.progress = 1;
      entry.xhr = null;
      renderFiles(state);
      return;
    }
    fail(data && data.error ? data.error.code : null);
  };
  xhr.onerror = function () { fail(null); };
  xhr.onabort = function () { entry.xhr = null; };
  xhr.send(file);
}

function removeFile(state, entry) {
  var at = state.files.indexOf(entry);
  if (at !== -1) state.files.splice(at, 1);
  if (entry.xhr) { try { entry.xhr.abort(); } catch (e) { /* already settled */ } }
  // A file no response holds yet is removed server-side right away (it would
  // be purged anyway); a file the response already holds leaves through the
  // next submit, which stops naming it.
  if (entry.id && !entry.attached && state.form) {
    fetchFn(formApi(state.form, '/uploads/' + encodeURIComponent(entry.id)), {
      method: 'DELETE', mode: 'cors', credentials: 'omit', headers: headers(null)
    }).then(function () {}, function () {});
  }
  setFieldMessage(state, null);
  renderFiles(state);
}

function paintProgress(entry) {
  if (entry.bar) entry.bar.style.width = Math.round(entry.progress * 100) + '%';
}

function renderFiles(state) {
  var drop = state.input && state.input.__slDrop;
  if (!drop) return;
  var list = drop.list;
  while (list.firstChild) list.removeChild(list.firstChild);
  state.files.forEach(function (entry) {
    var li = doc.createElement('li');
    li.className = 'sl-forms-file' + (entry.state === 'error' ? ' sl-forms-file-err' : '');
    li.setAttribute('data-slideless-file', entry.state);
    var name = doc.createElement('span');
    name.className = 'sl-forms-file-name';
    name.textContent = entry.name;
    li.appendChild(name);
    var size = doc.createElement('span');
    size.className = 'sl-forms-file-size';
    size.textContent = entry.state === 'error' ? entry.error : fmtSize(entry.size);
    li.appendChild(size);
    var x = doc.createElement('button');
    x.type = 'button';
    x.className = 'sl-forms-file-x';
    x.textContent = text(state.form, 'uploadRemove');
    x.addEventListener('click', function (e) { e.preventDefault(); removeFile(state, entry); });
    li.appendChild(x);
    if (entry.state === 'uploading') {
      var bar = doc.createElement('span');
      bar.className = 'sl-forms-file-bar';
      entry.bar = bar;
      li.appendChild(bar);
      paintProgress(entry);
    } else {
      entry.bar = null;
    }
    list.appendChild(li);
  });
  drop.msg.textContent = state.message || '';
  drop.msg.style.display = state.message ? '' : 'none';
}

// The files a returning respondent's answer already holds (names and sizes
// from the respondent wire), shown as files in place: removable, and kept by
// the next submit unless removed.
function prefillFiles(form, files) {
  if (!files || !files.length) return;
  mountUploads(form);
  var inputs = fileInputs(form);
  for (var i = 0; i < inputs.length; i++) {
    var state = upState(form, inputs[i]);
    if (state.files.length) continue;
    for (var j = 0; j < files.length; j++) {
      if (files[j].field !== inputs[i].name) continue;
      state.files.push({ key: ++UP_SEQ, id: files[j].id, name: String(files[j].name), size: files[j].sizeBytes,
        state: 'done', progress: 1, attached: true, xhr: null, error: null });
    }
    renderFiles(state);
  }
}

// What the submit names: { field: [upload ids] } for EVERY file field of the
// form, empty arrays included (an edit that removed every file must say so).
// Returns null when the form has no file field or uploads are off here, and
// { error } when a rule the author set does not hold yet.
function collectFiles(form) {
  var inputs = fileInputs(form);
  if (!inputs.length || !CFG.uploads) return null;
  mountUploads(form);
  var out = {};
  for (var i = 0; i < inputs.length; i++) {
    var input = inputs[i];
    var state = upState(form, input);
    var ids = [];
    for (var j = 0; j < state.files.length; j++) {
      var entry = state.files[j];
      if (entry.state === 'uploading') return { error: text(form, 'uploadBusy'), state: state };
      if (entry.state === 'done' && entry.id) ids.push(entry.id);
    }
    var rules = input.__slDrop.rules;
    if (ids.length < rules.min) {
      return { error: rules.min === 1 ? text(form, 'uploadRequired') : text(form, 'uploadTooFew', { min: rules.min }), state: state };
    }
    out[input.name] = ids;
  }
  return { files: out };
}

function markFilesAttached(form) {
  var inputs = fileInputs(form);
  for (var i = 0; i < inputs.length; i++) {
    var state = upState(form, inputs[i]);
    for (var j = 0; j < state.files.length; j++) if (state.files[j].state === 'done') state.files[j].attached = true;
  }
}

// ---- the dialog (PRDCT-2343) -------------------------------------------
// PER-FORM state: form.__slDialog is the scrim holding THIS form's
// confirmation, form.__slStatus the line left after the form when it is
// closed. The form itself is never hidden: the answers stay on screen and
// editable, and a new submit replaces the dialog's content.
var FOCUSABLE = 'button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])';

function openDialog(form, box) {
  var name = form.getAttribute('data-slideless-form');
  var scrim = doc.createElement('div');
  scrim.className = 'sl-forms-scrim';
  scrim.setAttribute('data-slideless-dialog', name);
  shield(scrim);
  scrim.addEventListener('submit', function (e) { e.stopPropagation(); });
  box.className += ' sl-forms-dialog';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.tabIndex = -1;
  var x = doc.createElement('button');
  x.type = 'button';
  x.className = 'sl-forms-x';
  x.setAttribute('aria-label', text(form, 'close'));
  x.title = text(form, 'close');
  x.textContent = '\xd7';
  x.addEventListener('click', function () { closeDialog(form); });
  box.insertBefore(x, box.firstChild);
  // A click on the scrim itself (outside the box) closes; inside, nothing.
  scrim.addEventListener('click', function (e) { if (e.target === scrim) closeDialog(form); });
  scrim.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' || e.key === 'Esc') { e.preventDefault(); closeDialog(form); return; }
    if (e.key !== 'Tab') return;
    // Tab cycles inside the box; Shift+Tab the other way.
    var items = box.querySelectorAll(FOCUSABLE);
    if (!items.length) { e.preventDefault(); return; }
    var first = items[0], last = items[items.length - 1];
    if (e.shiftKey && (doc.activeElement === first || doc.activeElement === box)) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && doc.activeElement === last) {
      e.preventDefault(); first.focus();
    }
  });
  scrim.appendChild(box);
  form.__slDialog = scrim;
  showDialog(form);
}

function showDialog(form) {
  var scrim = form.__slDialog;
  if (!scrim) return;
  if (!scrim.parentNode) (doc.body || doc.documentElement).appendChild(scrim);
  var box = scrim.firstChild;
  try { box.focus(); } catch (e) { /* focus is a nicety */ }
}

function closeDialog(form) {
  var scrim = form.__slDialog;
  if (scrim && scrim.parentNode) scrim.parentNode.removeChild(scrim);
  // The one-line status after the form: the essential line stays in reach,
  // and the dialog can be reopened as it was. Placed again on every close:
  // a deck that re-rendered its slide meanwhile detached the earlier one.
  if (!form.__slStatus) renderStatus(form);
  placeStatus(form);
  // Another form's dialog still open underneath (verifier round 1): focus
  // goes to the topmost one, or its Escape is dead with the focus on the
  // body.
  var scrims = doc.querySelectorAll('.sl-forms-scrim');
  var other = scrims.length ? scrims[scrims.length - 1] : null;
  if (other && other.firstChild) {
    try { other.firstChild.focus(); } catch (e) { /* the scrim click still closes it */ }
    return;
  }
  var back = form.__slReturnFocus;
  if (back && back.focus && doc.contains(back)) {
    try { back.focus(); } catch (e) { /* the form is still there either way */ }
  }
}

function renderStatus(form) {
  var el = doc.createElement('p');
  el.className = 'sl-forms-status';
  el.setAttribute('data-slideless-status', form.getAttribute('data-slideless-form'));
  shield(el);
  var line = doc.createElement('span');
  line.className = 'sl-forms-status-line';
  line.textContent = form.__slStatusText || '';
  el.appendChild(line);
  var show = doc.createElement('button');
  show.type = 'button';
  show.className = 'sl-forms-btn-2';
  show.textContent = text(form, 'show');
  show.addEventListener('click', function () { showDialog(form); });
  el.appendChild(show);
  form.__slStatus = el;
}

// After the form when the form is still in the document; after the live
// form of the same name when the deck re-rendered it (a slide rebuilt on
// navigation or on resize: verifier round 1, the personal link was then
// nowhere on the page); floating at the bottom of the viewport when there
// is no such form at all. The status never lands in a detached subtree.
function placeStatus(form) {
  var el = form.__slStatus;
  if (!el) return;
  var name = form.getAttribute('data-slideless-form');
  // ONE status per form name, the latest submit's (verifier round 2): a deck
  // that re-rendered its form gives the runtime a second form object with
  // its own dialog, and two lines offering two different links under one
  // form would leave the respondent guessing which is theirs.
  var olds = doc.querySelectorAll('[data-slideless-status]');
  for (var k = 0; k < olds.length; k++) {
    if (olds[k] !== el && olds[k].getAttribute('data-slideless-status') === name && olds[k].parentNode) {
      olds[k].parentNode.removeChild(olds[k]);
    }
  }
  var host = doc.contains(form) ? form : null;
  if (!host) {
    var live = doc.querySelectorAll(SELECTOR);
    for (var i = 0; i < live.length; i++) {
      if (live[i].getAttribute('data-slideless-form') === name) { host = live[i]; break; }
    }
  }
  if (host && host.parentNode) {
    el.className = 'sl-forms-status';
    el.style.bottom = '';
    if (el.previousSibling !== host) host.parentNode.insertBefore(el, host.nextSibling);
  } else {
    el.className = 'sl-forms-status sl-forms-status-floating';
    if (!doc.contains(el)) (doc.body || doc.documentElement).appendChild(el);
    // Several floating statuses (several forms gone) stack instead of
    // hiding one another (verifier round 2).
    var floats = doc.querySelectorAll('.sl-forms-status-floating');
    var slot = 0;
    for (var j = 0; j < floats.length; j++) { if (floats[j] === el) break; slot++; }
    el.style.bottom = (12 + slot * 52) + 'px';
  }
}

function clearConfirmation(form) {
  if (form.__slDialog && form.__slDialog.parentNode) {
    form.__slDialog.parentNode.removeChild(form.__slDialog);
  }
  form.__slDialog = null;
  if (form.__slStatus && form.__slStatus.parentNode) {
    form.__slStatus.parentNode.removeChild(form.__slStatus);
  }
  form.__slStatus = null;
}

// form.__slSecret is the edit secret of THIS form's own row. A single
// module-level variable used to be shared by every form on the page while
// ownership is per-form, so submitting form B filed the edit of form A under
// B, and "Email me my link" mailed a different respondent's secret
// (PRDCT-1334 item 2 — the worst functional defect in the audit).
function editLink(form) {
  return location.origin + location.pathname + '#slr=' + form.__slSecret;
}

// PRDCT-2328: a remembering link on a direct navigation. The LINK is the
// respondent's handle on their answer — no fragment secret, no "email me my
// link": the dialog says so and offers only "Edit response".
function remembering() {
  return CFG.remembers === true && CFG.source === 'link';
}

function card(form, updated) {
  clearConfirmation(form);
  // A resume prompt still on screen is now stale — the respondent answered
  // it by submitting. Leaving it would show two cards making different
  // claims about the same form.
  if (form.__slResume && form.__slResume.parentNode) {
    form.__slResume.parentNode.removeChild(form.__slResume);
    form.__slResume = null;
  }
  var el = doc.createElement('div');
  el.className = 'sl-forms-card';
  // The dialog names ITS form: per-form state is the fix for the cross-form
  // corruption, so make it observable rather than implied (PRDCT-1334).
  el.setAttribute('data-slideless-card', form.getAttribute('data-slideless-form'));
  var msg = updated ? text(form, 'updated') : text(form, 'success');
  form.__slStatusText = msg;
  el.setAttribute('aria-label', msg);
  var ok = doc.createElement('p');
  ok.className = 'sl-forms-ok';
  ok.textContent = msg;
  el.appendChild(ok);

  if (remembering()) {
    var kept = doc.createElement('p');
    kept.textContent = text(form, 'remembers');
    el.appendChild(kept);
    var rrow = doc.createElement('div');
    rrow.className = 'sl-forms-row';
    var redit = doc.createElement('button');
    redit.type = 'button';
    redit.className = 'sl-forms-btn-2';
    redit.textContent = text(form, 'edit');
    redit.addEventListener('click', function () { closeDialog(form); });
    rrow.appendChild(redit);
    el.appendChild(rrow);
    openDialog(form, el);
    return;
  }

  var keep = doc.createElement('p');
  keep.textContent = text(form, 'keepLink');
  el.appendChild(keep);
  var link = doc.createElement('a');
  link.className = 'sl-forms-link';
  link.href = editLink(form);
  link.textContent = editLink(form);
  // target=_blank so the link escapes an embed's frame (the sandbox carries
  // allow-popups). It used to preventDefault(), which made it dead
  // everywhere — the only escape left was selecting the text by hand.
  link.target = '_blank';
  link.rel = 'noopener';
  el.appendChild(link);

  var row = doc.createElement('div');
  row.className = 'sl-forms-row';
  var copy = doc.createElement('button');
  copy.type = 'button';
  copy.className = 'sl-forms-btn-2';
  copy.textContent = text(form, 'copy');
  copy.addEventListener('click', function () {
    // navigator.clipboard rejects with NotAllowedError in the sandboxed
    // opaque origin, so the async API is the FALLBACK here, not the primary
    // path, and a failure is surfaced instead of swallowed.
    var value = editLink(form);
    var done = function () { copy.textContent = text(form, 'copied'); };
    var failed = function () {
      copy.textContent = text(form, 'copyFailed');
      selectText(link);
    };
    if (execCopy(value)) { done(); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(done, failed);
    } else {
      failed();
    }
  });
  row.appendChild(copy);
  var edit = doc.createElement('button');
  edit.type = 'button';
  edit.className = 'sl-forms-btn-2';
  edit.textContent = text(form, 'edit');
  edit.addEventListener('click', function () { closeDialog(form); });
  row.appendChild(edit);
  el.appendChild(row);

  if (CFG.emailAvailable) {
    var mailRow = doc.createElement('div');
    mailRow.className = 'sl-forms-row';
    mailRow.style.marginTop = '10px';
    var mail = doc.createElement('input');
    mail.type = 'email';
    mail.className = 'sl-forms-mail';
    mail.placeholder = text(form, 'emailPlaceholder');
    mailRow.appendChild(mail);
    var send = doc.createElement('button');
    send.type = 'button';
    send.className = 'sl-forms-btn';
    send.textContent = text(form, 'emailSend');
    send.addEventListener('click', function () {
      if (!mail.value) return;
      send.disabled = true;
      fetchFn(formApi(form, '/responses/me/email'), {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        headers: headers(form.__slSecret),
        body: JSON.stringify({ email: mail.value })
      }).then(function (res) {
        send.disabled = false;
        send.textContent = res.ok ? text(form, 'emailSent') : text(form, 'emailFailed');
      }, function () {
        send.disabled = false;
        send.textContent = text(form, 'emailFailed');
      });
    });
    mailRow.appendChild(send);
    el.appendChild(mailRow);
    var note = doc.createElement('p');
    note.className = 'sl-forms-note';
    note.textContent = text(form, 'emailNote');
    el.appendChild(note);
  }

  openDialog(form, el);
}

function selectText(node) {
  try {
    var range = doc.createRange();
    range.selectNodeContents(node);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  } catch (e) { /* selection is a nicety, never a failure */ }
}

function execCopy(value) {
  try {
    var ta = doc.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    doc.body.appendChild(ta);
    ta.select();
    var ok = doc.execCommand && doc.execCommand('copy');
    doc.body.removeChild(ta);
    return ok === true;
  } catch (e) {
    return false;
  }
}

function showError(form, message) {
  var el = form.__slErr;
  if (!el) {
    el = doc.createElement('p');
    el.className = 'sl-forms-err';
    el.setAttribute('role', 'alert');
    form.appendChild(el);
    form.__slErr = el;
  }
  el.textContent = message;
}

function clearError(form) {
  if (form.__slErr && form.__slErr.parentNode) form.__slErr.parentNode.removeChild(form.__slErr);
  form.__slErr = null;
}

// ---- submit ------------------------------------------------------------
function submitForm(form) {
  if (form.__slBusy) return;
  form.__slBusy = true;
  clearError(form);
  // Own-row update ONLY when this form itself owns a secret: either it just
  // created the row, or the respondent explicitly chose "Edit it" below.
  // On a REMEMBERING link (PRDCT-2328) every submit is a POST: the server
  // creates the link's remembered row the first time and updates it after,
  // atomically, so two tabs cannot race into two rows. The fragment path
  // (an old personal link pasted on a remembering link) still PUTs its own
  // row by secret, exactly as before.
  var own = form.__slOwn === true && !!form.__slSecret;
  var url = own ? formApi(form, '/responses/me') : formApi(form, '/responses');
  // File fields (PRDCT-2403): the submit names the files already uploaded.
  // An upload still running, or a count under the author's minimum, stops
  // the submit with the reason under the field itself.
  var picked = collectFiles(form);
  if (picked && picked.error) {
    form.__slBusy = false;
    setFieldMessage(picked.state, picked.error);
    var panelEl = picked.state.input && picked.state.input.__slDrop ? picked.state.input.__slDrop.panel : null;
    if (panelEl && panelEl.focus) { try { panelEl.focus(); } catch (e) { /* focus is a nicety */ } }
    return;
  }
  // source/placement/version ride BOTH verbs: an edited row used to keep the
  // creator's attribution forever (PRDCT-1332, related finding).
  var body = {
    payload: serialize(form),
    version: CFG.version,
    source: CFG.source,
    placement: CFG.placement || undefined,
    files: picked ? picked.files : undefined
  };
  fetchFn(url, {
    method: own ? 'PUT' : 'POST',
    mode: 'cors',
    credentials: 'omit',
    headers: headers(own ? form.__slSecret : null),
    body: JSON.stringify(body)
  }).then(function (res) {
    form.__slBusy = false;
    if (res.status === 201 || res.status === 200) {
      return res.json().then(function (data) {
        if (data && data.editSecret) form.__slSecret = data.editSecret;
        // A remembering POST never hands the runtime a secret to keep: the
        // link is the handle. Keep the form on the POST path.
        if (!(data && data.remembered === true)) form.__slOwn = true;
        markFilesAttached(form);
        card(form, own === true || (data && data.edited === true));
      }, function () { card(form, own === true); });
    }
    return res.json().then(function (data) {
      // The owner turned file uploads off while this page was open: say it
      // in the deck's language rather than the server's English.
      var msg = data && data.error && data.error.code === 'uploads_disabled'
        ? text(form, 'uploadUnavailable')
        : data && data.error && data.error.message
        ? data.error.message
        : text(form, 'errorGeneric');
      showError(form, msg);
    }, function () {
      showError(form, text(form, 'errorGeneric'));
    });
  }, function () {
    form.__slBusy = false;
    showError(form, text(form, 'errorNetwork'));
  });
}

// ---- wiring ------------------------------------------------------------
// Delegated capture-phase submit on the document: a form rendered later (a
// deck that builds its slides on DOMContentLoaded) used to be missed by the
// one-shot querySelectorAll, and its native submit garbage-navigated the
// sandbox with the answers in the query string, storing nothing
// (PRDCT-1334 item 3).
doc.addEventListener('submit', function (e) {
  var form = e.target && e.target.closest ? e.target.closest(SELECTOR) : null;
  if (!form) return;
  // The runtime owns data-slideless-form submits end-to-end.
  e.preventDefault();
  e.stopPropagation();
  wire(form);
  // Where focus returns when the dialog closes: the control that submitted,
  // else whatever was focused, else the form itself.
  form.__slReturnFocus = (e.submitter && e.submitter.focus) ? e.submitter
    : (doc.activeElement && form.contains(doc.activeElement)) ? doc.activeElement
    : form;
  submitForm(form);
}, true);

function wire(form) {
  if (form.__slWired) return;
  form.__slWired = true;
  shield(form);
  mountUploads(form);
  if (candidateSecret) offerResume(form);
  else if (remembering()) prefillRemembered(form);
}

// ---- remembering link (PRDCT-2328) ------------------------------------
// ONE probe per page load, whatever the number of forms: the link's
// remembered rows, one per form, resolved by the SHARE SECRET alone (no
// fragment, no edit secret — the link is the credential, by the owner's
// choice at mint). Nothing here asks the respondent to confirm: on a
// remembering link the answers ARE theirs by construction, that is what the
// owner minted. An arriving fragment secret wins over this path (the old
// personal-link flow, with its explicit prompt), see wire().
var rememberedProbe = null;
function probeRemembered() {
  if (rememberedProbe) return rememberedProbe;
  rememberedProbe = fetchFn(apiBase + '/responses/remembered', {
    method: 'GET',
    mode: 'cors',
    credentials: 'omit',
    headers: headers(null)
  }).then(function (res) {
    if (!res.ok) return [];
    return res.json().then(function (data) {
      return data && data.responses ? data.responses : [];
    }, function () { return []; });
  }, function () { return []; });
  return rememberedProbe;
}

function prefillRemembered(form) {
  if (form.__slRememberAsked) return;
  form.__slRememberAsked = true;
  probeRemembered().then(function (rows) {
    var name = form.getAttribute('data-slideless-form');
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].formName !== name) continue;
      if (form.__slBusy || form.__slDialog) return;
      prefill(form, rows[i].payload || {});
      prefillFiles(form, rows[i].files);
      form.__slRemembered = true;
      return;
    }
  });
}

function wireAll() {
  var forms = doc.querySelectorAll(SELECTOR);
  for (var i = 0; i < forms.length; i++) {
    wire(forms[i]);
    // A deck that rebuilds a slide inside the same form brings new inputs.
    mountUploads(forms[i]);
  }
}
// Coalesced: a slide deck mutates its DOM constantly and wireAll runs a
// document-wide query.
var rescanQueued = false;
function scheduleWireAll() {
  if (rescanQueued) return;
  rescanQueued = true;
  setTimeout(function () { rescanQueued = false; wireAll(); }, 0);
}
wireAll();
if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', wireAll);
if (typeof MutationObserver === 'function') {
  new MutationObserver(scheduleWireAll).observe(doc.documentElement, { childList: true, subtree: true });
}

// ---- returning respondent (fragment secret) ---------------------------
// NEVER silently adopted. The fragment is controlled by whoever wrote the
// link or the embed div, so an attacker can submit one EMPTY response, keep
// its secret and hand out .../v/{secret}/#slr=<theirs>: the victim's answers
// would overwrite the attacker's row, readable by the attacker
// (PRDCT-1332). The respondent is shown what is happening and CREATE stays
// the default.
// ONE probe per page load, whatever the number of forms: the candidate is
// resolved through the form-agnostic own-row route and the answer (a row
// naming its form, or nothing) is shared by every form wired now or later.
// Probing once PER FORM through the form-bound route burned the submit
// bucket N times per page load on a bogus fragment — a two-form deck
// reloaded ten times locked every respondent behind the same NAT out for
// ten minutes (PRDCT-1331/1334 residual). The own-row routes still carry
// the FORM NAME on edit (PRDCT-1334 item 2): the resume prompt is offered
// only on the form the resolved row names, and the server enforces the
// match on the PUT regardless.
// A failed probe (network blip, non-2xx) settles to null for the whole page
// load — deliberately: retrying per late-wired form is the per-form cost
// again. The respondent still holds their link; a reload probes once more.
var resumeProbe = null;
function probeCandidate() {
  if (resumeProbe) return resumeProbe;
  resumeProbe = fetchFn(apiBase + '/responses/me', {
    method: 'GET',
    mode: 'cors',
    credentials: 'omit',
    headers: headers(candidateSecret)
  }).then(function (res) {
    if (!res.ok) return null;
    return res.json().then(function (data) {
      return data && data.response ? data.response : null;
    }, function () { return null; });
  }, function () { return null; });
  return resumeProbe;
}

function offerResume(form) {
  if (form.__slResumeAsked) return;
  form.__slResumeAsked = true;
  probeCandidate().then(function (row) {
    if (!row || row.formName !== form.getAttribute('data-slideless-form')) return;
    // Anything already happening on this form wins over the prompt.
    if (form.__slOwn || form.__slBusy || form.__slDialog || form.__slResume) return;
    renderResume(form, row);
  });
}

// Inline before the form, never modal (see the header): create is the
// default, so the respondent must be able to ignore the prompt and type.
function renderResume(form, row) {
  var el = doc.createElement('div');
  el.className = 'sl-forms-card';
  el.setAttribute('data-slideless-resume', form.getAttribute('data-slideless-form'));
  shield(el);
  var lang = form.__slLang || (form.__slLang = langOf(form));
  var when = '';
  try { when = new Date(row.createdAt).toLocaleString(lang === 'en' ? undefined : lang); }
  catch (e) { when = row.createdAt; }
  var p = doc.createElement('p');
  p.className = 'sl-forms-ok';
  p.textContent = text(form, 'resumeTitle', { date: when });
  el.appendChild(p);
  var why = doc.createElement('p');
  why.textContent = text(form, 'resumeWhy');
  el.appendChild(why);
  var row2 = doc.createElement('div');
  row2.className = 'sl-forms-row';
  var editBtn = doc.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'sl-forms-btn-2';
  editBtn.textContent = text(form, 'resumeEdit');
  editBtn.addEventListener('click', function () {
    form.__slSecret = candidateSecret;
    form.__slOwn = true;
    prefill(form, row.payload || {});
    prefillFiles(form, row.files);
    el.parentNode && el.parentNode.removeChild(el);
    form.__slResume = null;
  });
  row2.appendChild(editBtn);
  var newBtn = doc.createElement('button');
  newBtn.type = 'button';
  newBtn.className = 'sl-forms-btn';
  newBtn.textContent = text(form, 'resumeNew');
  newBtn.addEventListener('click', function () {
    el.parentNode && el.parentNode.removeChild(el);
    form.__slResume = null;
  });
  row2.appendChild(newBtn);
  el.appendChild(row2);
  form.parentNode.insertBefore(el, form);
  form.__slResume = el;
}
`;

/**
 * A server-controlled value serialized into the inline script: JSON with
 * `<` escaped, so no string inside it, however it was authored, can close
 * the script early. One function for the config and the catalogue, pinned
 * by a unit test against a value that carries a closing tag.
 */
export function serializeForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export function formsScriptTag(cfg: FormsConfig): string {
  const json = serializeForScript({
    version: cfg.version,
    unlock: cfg.unlock,
    source: cfg.source,
    placement: cfg.placement,
    emailAvailable: cfg.emailAvailable,
    remembers: cfg.remembers,
    uploads: cfg.uploads
  });
  // The catalogue rides the same way: server-authored, `<` escaped so no
  // string could ever close the script (none carries one; the unit test
  // pins that too, and this escape is the belt to that brace).
  const catalogue = serializeForScript(FORMS_CATALOGUE);
  // NO blanket try/catch: it made every real-deck failure silent by
  // construction (five of five decks broke and the suite stayed green —
  // PRDCT-1334). A throw now surfaces in the console, and an IIFE that
  // throws cannot damage the deck: the runtime touches nothing until it
  // wires a form.
  return `\n<script ${FORMS_MARKER}>\n(function(){\n"use strict";\nvar CFG=${json};\nvar CATALOGUE=${catalogue};\nvar TEXT_MAX=${FORMS_TEXT_MAX};\n${FORMS_JS}\n})();\n</script>\n`;
}
