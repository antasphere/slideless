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
  'show'
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
    show: 'Show confirmation'
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
    show: 'Afficher la confirmation'
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
    show: 'Bevestiging tonen'
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
    show: 'Bestätigung anzeigen'
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
    show: 'Mostrar la confirmación'
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
  '.sl-forms-status .sl-forms-btn-2{padding:4px 10px;font-size:12px}';
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
// FormData -> flat { name: string | string[] }. Files are skipped (out of
// scope v1); repeated names accumulate into arrays — the server validates
// shape and size, never meaning.
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
  // and the dialog can be reopened as it was.
  if (!form.__slStatus) renderStatus(form);
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
  form.parentNode.insertBefore(el, form.nextSibling);
  form.__slStatus = el;
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
  // source/placement/version ride BOTH verbs: an edited row used to keep the
  // creator's attribution forever (PRDCT-1332, related finding).
  var body = {
    payload: serialize(form),
    version: CFG.version,
    source: CFG.source,
    placement: CFG.placement || undefined
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
        card(form, own === true || (data && data.edited === true));
      }, function () { card(form, own === true); });
    }
    return res.json().then(function (data) {
      var msg = data && data.error && data.error.message
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
      form.__slRemembered = true;
      return;
    }
  });
}

function wireAll() {
  var forms = doc.querySelectorAll(SELECTOR);
  for (var i = 0; i < forms.length; i++) wire(forms[i]);
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

export function formsScriptTag(cfg: FormsConfig): string {
  const json = JSON.stringify({
    version: cfg.version,
    unlock: cfg.unlock,
    source: cfg.source,
    placement: cfg.placement,
    emailAvailable: cfg.emailAvailable,
    remembers: cfg.remembers
  }).replace(/</g, '\\u003c');
  // The catalogue rides the same way: server-authored, `<` escaped so no
  // string could ever close the script (none carries one; the unit test
  // pins that too, and this escape is the belt to that brace).
  const catalogue = JSON.stringify(FORMS_CATALOGUE).replace(/</g, '\\u003c');
  // NO blanket try/catch: it made every real-deck failure silent by
  // construction (five of five decks broke and the suite stayed green —
  // PRDCT-1334). A throw now surfaces in the console, and an IIFE that
  // throws cannot damage the deck: the runtime touches nothing until it
  // wires a form.
  return `\n<script ${FORMS_MARKER}>\n(function(){\n"use strict";\nvar CFG=${json};\nvar CATALOGUE=${catalogue};\nvar TEXT_MAX=${FORMS_TEXT_MAX};\n${FORMS_JS}\n})();\n</script>\n`;
}
