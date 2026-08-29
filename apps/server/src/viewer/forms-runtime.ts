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
 * the token-session form API (viewer/forms-api.ts), and swaps the form for
 * a confirmation card carrying the respondent's personal EDIT LINK (the
 * current page URL + `#slr=<edit secret>`).
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
 * — version, source, placement, emailAvailable — is server CONTEXT, not
 * capability, and the server re-derives or re-validates each of them at
 * write time.
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
 *  - Both the confirmation card AND every marked form stop event
 *    propagation at their root, so clicking a field or typing a space never
 *    drives the deck's own navigation (PRDCT-1334 item 1: five of five real
 *    decks broke on this). Bubble phase, deliberately: a capture-phase
 *    shield on the form would also kill the AUTHOR's own listeners inside
 *    it. Deck listeners bound with `capture: true` on document still win, as
 *    they always did for the card.
 *  - An arriving `#slr=` fragment is NEVER silently adopted into update
 *    mode. A framer or a link author controls the fragment, so an attacker
 *    could plant their own empty response's secret and harvest the answers
 *    a stranger typed (PRDCT-1332, audit §2). The runtime shows an explicit
 *    resume prompt and defaults to CREATE. The fragment is resolved ONCE
 *    per page load (form-agnostic own-row GET), never once per form: each
 *    unresolvable probe burns the submit bucket, and N forms × reloads was
 *    a lockout for everyone behind one NAT (PRDCT-1331/1334 residual).
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
}

/** Attribute marking the injected script — tests and humans grep for it. */
export const FORMS_MARKER = 'data-slideless-forms';

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

// ---- styles ------------------------------------------------------------
var style = doc.createElement('style');
style.textContent =
  '.sl-forms-card{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;' +
  'background:#fff;color:#18181b;border:1px solid #e4e4e7;border-radius:10px;padding:16px;' +
  'margin:8px 0;font-size:14px;line-height:1.5;box-shadow:0 1px 3px rgba(0,0,0,.06)}' +
  '.sl-forms-card p{margin:0 0 10px}' +
  '.sl-forms-ok{font-weight:600}' +
  '.sl-forms-link{word-break:break-all;font-size:12px;color:#3f3f46;background:#f4f4f5;' +
  'border-radius:6px;padding:6px 8px;display:block;margin:0 0 10px}' +
  '.sl-forms-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}' +
  '.sl-forms-btn{background:#18181b;color:#fff;border:0;border-radius:7px;padding:7px 12px;' +
  'font-size:13px;font-weight:600;cursor:pointer}' +
  '.sl-forms-btn-2{background:#fff;color:#18181b;border:1px solid #d4d4d8;border-radius:7px;' +
  'padding:7px 12px;font-size:13px;cursor:pointer}' +
  '.sl-forms-mail{flex:1;min-width:160px;box-sizing:border-box;padding:7px 10px;' +
  'border:1px solid #d4d4d8;border-radius:7px;font-size:13px}' +
  '.sl-forms-err{color:#dc2626;font-size:13px;margin:6px 0 0}' +
  '.sl-forms-note{color:#52525b;font-size:12px;margin:6px 0 0}';
doc.documentElement.appendChild(style);

// ---- deck-handler shield -----------------------------------------------
// Every real deck binds document-level keydown/click navigation. Without
// this, clicking a field flips the slide, space is swallowed mid-word, and
// submitting navigates away from the confirmation card.
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
    if (Object.prototype.hasOwnProperty.call(out, key)) {
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

// ---- confirmation card -------------------------------------------------
// PER-FORM state: form.__slSecret is the edit secret of THIS form's own row.
// A single module-level variable used to be shared by every form on the
// page while ownership is per-form, so submitting form B filed the edit of
// form A under B, and "Email me my link" mailed a different respondent's
// secret (PRDCT-1334 item 2 — the worst functional defect in the audit).
function editLink(form) {
  return location.origin + location.pathname + '#slr=' + form.__slSecret;
}

function card(form, updated) {
  var old = form.__slCard;
  if (old && old.parentNode) old.parentNode.removeChild(old);
  // A resume prompt still on screen is now stale — the respondent answered
  // it by submitting. Leaving it would show two cards making different
  // claims about the same form.
  if (form.__slResume && form.__slResume.parentNode) {
    form.__slResume.parentNode.removeChild(form.__slResume);
    form.__slResume = null;
  }
  var el = doc.createElement('div');
  el.className = 'sl-forms-card';
  // The card names ITS form: per-form state is the fix for the cross-form
  // corruption, so make it observable rather than implied (PRDCT-1334).
  el.setAttribute('data-slideless-card', form.getAttribute('data-slideless-form'));
  shield(el);
  el.addEventListener('submit', function (e) { e.stopPropagation(); });
  var msg = form.getAttribute('data-slideless-success') || 'Your response has been recorded.';
  var ok = doc.createElement('p');
  ok.className = 'sl-forms-ok';
  ok.textContent = updated ? 'Your response has been updated.' : msg;
  el.appendChild(ok);

  var keep = doc.createElement('p');
  keep.textContent = 'Keep this personal link to view or update your answer later:';
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
  copy.textContent = 'Copy link';
  copy.addEventListener('click', function () {
    // navigator.clipboard rejects with NotAllowedError in the sandboxed
    // opaque origin, so the async API is the FALLBACK here, not the primary
    // path, and a failure is surfaced instead of swallowed.
    var text = editLink(form);
    var done = function () { copy.textContent = 'Copied'; };
    var failed = function () {
      copy.textContent = 'Press Ctrl+C';
      selectText(link);
    };
    if (execCopy(text)) { done(); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, failed);
    } else {
      failed();
    }
  });
  row.appendChild(copy);
  var edit = doc.createElement('button');
  edit.type = 'button';
  edit.className = 'sl-forms-btn-2';
  edit.textContent = 'Edit response';
  edit.addEventListener('click', function () {
    el.parentNode && el.parentNode.removeChild(el);
    form.style.display = form.__slDisplay || '';
  });
  row.appendChild(edit);
  el.appendChild(row);

  if (CFG.emailAvailable) {
    var mailRow = doc.createElement('div');
    mailRow.className = 'sl-forms-row';
    mailRow.style.marginTop = '10px';
    var mail = doc.createElement('input');
    mail.type = 'email';
    mail.className = 'sl-forms-mail';
    mail.placeholder = 'you@example.com';
    mailRow.appendChild(mail);
    var send = doc.createElement('button');
    send.type = 'button';
    send.className = 'sl-forms-btn';
    send.textContent = 'Email me my link';
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
        send.textContent = res.ok ? 'Sent' : 'Try again later';
      }, function () {
        send.disabled = false;
        send.textContent = 'Try again later';
      });
    });
    mailRow.appendChild(send);
    el.appendChild(mailRow);
    var note = doc.createElement('p');
    note.className = 'sl-forms-note';
    note.textContent = 'Optional: get the link by email so you can come back to it.';
    el.appendChild(note);
  }

  form.__slDisplay = form.style.display;
  form.style.display = 'none';
  form.parentNode.insertBefore(el, form.nextSibling);
  form.__slCard = el;
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

function execCopy(text) {
  try {
    var ta = doc.createElement('textarea');
    ta.value = text;
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
        form.__slOwn = true;
        card(form, own === true);
      }, function () { card(form, own === true); });
    }
    return res.json().then(function (data) {
      var msg = data && data.error && data.error.message
        ? data.error.message
        : 'Something went wrong — please try again.';
      showError(form, msg);
    }, function () {
      showError(form, 'Something went wrong — please try again.');
    });
  }, function () {
    form.__slBusy = false;
    showError(form, 'Network error — please try again.');
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
  submitForm(form);
}, true);

function wire(form) {
  if (form.__slWired) return;
  form.__slWired = true;
  shield(form);
  if (candidateSecret) offerResume(form);
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
    if (form.__slOwn || form.__slBusy || form.__slCard || form.__slResume) return;
    renderResume(form, row);
  });
}

function renderResume(form, row) {
  var el = doc.createElement('div');
  el.className = 'sl-forms-card';
  el.setAttribute('data-slideless-resume', form.getAttribute('data-slideless-form'));
  shield(el);
  var when = '';
  try { when = new Date(row.createdAt).toLocaleString(); } catch (e) { when = row.createdAt; }
  var p = doc.createElement('p');
  p.className = 'sl-forms-ok';
  p.textContent = 'This link points at a response submitted on ' + when + '.';
  el.appendChild(p);
  var why = doc.createElement('p');
  why.textContent =
    'Choose "Edit that response" only if it is yours — editing replaces its answers. ' +
    'Otherwise submit a new response.';
  el.appendChild(why);
  var row2 = doc.createElement('div');
  row2.className = 'sl-forms-row';
  var editBtn = doc.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'sl-forms-btn-2';
  editBtn.textContent = 'Edit that response';
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
  newBtn.textContent = 'Submit a new response';
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
    emailAvailable: cfg.emailAvailable
  }).replace(/</g, '\\u003c');
  // NO blanket try/catch: it made every real-deck failure silent by
  // construction (five of five decks broke and the suite stayed green —
  // PRDCT-1334). A throw now surfaces in the console, and an IIFE that
  // throws cannot damage the deck: the runtime touches nothing until it
  // wires a form.
  return `\n<script ${FORMS_MARKER}>\n(function(){\n"use strict";\nvar CFG=${json};\n${FORMS_JS}\n})();\n</script>\n`;
}
