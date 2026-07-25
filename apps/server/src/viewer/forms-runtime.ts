/**
 * The forms runtime client (ADR 022): a single self-contained inline
 * <script> injected into same-deck HTML document AND frame navigations
 * (viewer/inject.ts) for tokens with `can_submit_forms`. Vanilla JS +
 * inline CSS, zero external requests — the sandbox CSP allows scripts but
 * the page must stay self-sufficient.
 *
 * It wires every `<form data-slideless-form="name">` the deck author wrote:
 * intercepts submit, serializes FormData to a flat JSON payload, POSTs to
 * the token-session form API (viewer/forms-api.ts), and swaps the form for
 * a confirmation card carrying the respondent's personal EDIT LINK (the
 * current page URL + `#slr=<edit secret>`). Returning with that fragment,
 * it fetches the row, prefills the form, and submits become updates.
 *
 * TRUST BOUNDARY — same as the overlay (viewer/overlay.ts): the runtime
 * shares the document with untrusted deck JS inside the sandboxed opaque
 * origin. The share-token secret is already in location.pathname; the
 * injected config adds the unlock proof (password tokens, scoped to viewer
 * calls on this same token) and the respondent assertion (scoped to
 * IDENTITY-STAMPING a submission on this same token — it grants no read,
 * no session, no principal). Deck JS could call the form API itself with
 * all of these; the runtime adds NO capability the deck did not have. The
 * server re-validates everything regardless: token, capability, password,
 * payload shape/size, rate buckets, per-deck cap.
 *
 *  - Requests go out `credentials: 'omit'` (the Firefox opaque-origin
 *    residual, ADR 012).
 *  - UNLIKE the overlay there is NO `self !== top` refusal: frames are the
 *    embed case, deliberately served (ADR 022; the ADR 021 §1 rationale).
 *  - The confirmation card stops event propagation at its root so clicking
 *    it never drives the deck's own navigation (the PRDCT-1241 lesson);
 *    capture-phase deck listeners still win by design.
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
  /** Signed respondent assertion for signed-in viewers (else null). */
  assertion: string | null;
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

// ---- URL model ---------------------------------------------------------
// The viewer serves the deck under /v/{secret}[/{path}]. The RAW (still
// percent-encoded) secret segment authenticates API calls; the personal
// edit link is THIS page's URL plus the fragment secret.
var rawSecret, apiBase;
try {
  var seg = location.pathname.split('/');
  if (seg[1] !== 'v' || !seg[2]) return;
  rawSecret = seg[2];
  apiBase = new URL('/api/v1/viewer/' + rawSecret + '/forms', location.href).toString();
} catch (e) { return; }

var forms = doc.querySelectorAll('form[data-slideless-form]');
if (!forms.length) return;

// ---- edit-secret state -------------------------------------------------
// Held in memory only (the opaque origin has no storage): the fragment on
// arrival, or the secret minted by this page's own successful create.
var editSecret = null;
var fragMatch = /[#&]slr=([A-Za-z0-9_-]{20,128})/.exec(location.hash || '');
if (fragMatch) editSecret = fragMatch[1];

function headers(withSecret) {
  var h = { 'content-type': 'application/json' };
  if (CFG.unlock) h['x-slideless-unlock'] = CFG.unlock;
  if (withSecret && editSecret) h['x-slideless-response'] = editSecret;
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
  '.sl-forms-note{color:#a1a1aa;font-size:12px;margin:6px 0 0}';
doc.documentElement.appendChild(style);

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
function editLink() {
  return location.origin + location.pathname + '#slr=' + editSecret;
}

function card(form, updated) {
  var old = form.__slCard;
  if (old && old.parentNode) old.parentNode.removeChild(old);
  var el = doc.createElement('div');
  el.className = 'sl-forms-card';
  // Never drive the deck from card clicks (bubble-phase; PRDCT-1241).
  ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'keydown', 'keyup', 'submit'].forEach(
    function (t) { el.addEventListener(t, function (e) { e.stopPropagation(); }); }
  );
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
  link.href = editLink();
  link.textContent = editLink();
  link.addEventListener('click', function (e) { e.preventDefault(); });
  el.appendChild(link);

  var row = doc.createElement('div');
  row.className = 'sl-forms-row';
  var copy = doc.createElement('button');
  copy.type = 'button';
  copy.className = 'sl-forms-btn-2';
  copy.textContent = 'Copy link';
  copy.addEventListener('click', function () {
    var done = function () { copy.textContent = 'Copied'; };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(editLink()).then(done, function () {});
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
      fetchFn(apiBase + '/responses/me/email', {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        headers: headers(true),
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

function showError(form, message) {
  var el = form.__slErr;
  if (!el) {
    el = doc.createElement('p');
    el.className = 'sl-forms-err';
    form.appendChild(el);
    form.__slErr = el;
  }
  el.textContent = message;
}

function clearError(form) {
  if (form.__slErr && form.__slErr.parentNode) form.__slErr.parentNode.removeChild(form.__slErr);
  form.__slErr = null;
}

// ---- submit wiring -----------------------------------------------------
function wire(form) {
  form.addEventListener('submit', function (e) {
    // The runtime owns data-slideless-form submits end-to-end: the native
    // navigation would garbage-navigate the sandboxed document.
    e.preventDefault();
    e.stopPropagation();
    if (form.__slBusy) return;
    form.__slBusy = true;
    clearError(form);
    var own = form.__slOwn === true && !!editSecret;
    var url = own
      ? apiBase + '/responses/me'
      : apiBase + '/' + encodeURIComponent(form.getAttribute('data-slideless-form')) + '/responses';
    var body = own
      ? { payload: serialize(form) }
      : {
          payload: serialize(form),
          version: CFG.version,
          source: CFG.source,
          placement: CFG.placement || undefined,
          assertion: CFG.assertion || undefined
        };
    fetchFn(url, {
      method: own ? 'PUT' : 'POST',
      mode: 'cors',
      credentials: 'omit',
      headers: headers(own),
      body: JSON.stringify(body)
    }).then(function (res) {
      form.__slBusy = false;
      if (res.status === 201 || res.status === 200) {
        return res.json().then(function (data) {
          if (data && data.editSecret) editSecret = data.editSecret;
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
  });
}

for (var i = 0; i < forms.length; i++) wire(forms[i]);

// ---- returning respondent (fragment secret) ---------------------------
// Fetch the own row, prefill its form, and make that form update in place.
if (editSecret) {
  fetchFn(apiBase + '/responses/me', {
    method: 'GET',
    mode: 'cors',
    credentials: 'omit',
    headers: headers(true)
  }).then(function (res) {
    if (!res.ok) { editSecret = null; return; }
    return res.json().then(function (data) {
      if (!data || !data.response) { editSecret = null; return; }
      for (var i = 0; i < forms.length; i++) {
        if (forms[i].getAttribute('data-slideless-form') === data.response.formName) {
          prefill(forms[i], data.response.payload || {});
          forms[i].__slOwn = true;
          return;
        }
      }
      // The row's form is not on this page (multi-page deck) — keep the
      // secret so a matching form elsewhere still updates, do nothing here.
    });
  }, function () {});
}
`;

export function formsScriptTag(cfg: FormsConfig): string {
  const json = JSON.stringify({
    version: cfg.version,
    unlock: cfg.unlock,
    source: cfg.source,
    placement: cfg.placement,
    assertion: cfg.assertion,
    emailAvailable: cfg.emailAvailable
  }).replace(/</g, '\\u003c');
  return `\n<script ${FORMS_MARKER}>\n(function(){\n"use strict";\ntry{\nvar CFG=${json};\n${FORMS_JS}\n}catch(e){}\n})();\n</script>\n`;
}
