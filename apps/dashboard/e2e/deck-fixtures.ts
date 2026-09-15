/**
 * REAL-DECK E2E FIXTURES (PRDCT-1334).
 *
 * The forms e2e suite used to exercise a bare `<form>` with no deck around
 * it, and that is precisely why five of five genuine presentations broke on
 * a feature whose own suite was green. These fixtures put the runtime back
 * in its habitat: the navigation engines below are lifted VERBATIM from
 * decks in `workspace/content/presentations/`, so the handler shapes the
 * runtime has to survive are the real ones, not an approximation.
 *
 * Three distinct hostile shapes, each of which broke the feature:
 *
 *  1. `2026-07-05-architecture-de-marque` — `document` keydown navigation
 *     where SPACE advances the slide and calls `preventDefault()`, plus a
 *     click handler on the `#deck` ancestor that flips the slide on any
 *     click that is not a dot or an anchor. Typing "Jean Dupont" lost its
 *     space; clicking the name field navigated backwards; clicking submit
 *     navigated away so the confirmation card was born inside a hidden
 *     slide and the respondent never got their edit link.
 *  2. `2026-04-22-reb-app-analysis` — DIGIT hotkeys on `document` keydown,
 *     and `history.replaceState(null,'','#slide=1')` at start-up, which
 *     wipes the `#slr=` fragment before the end-of-body runtime can read
 *     it. Typing an email jumped the deck; the edit link died.
 *  3. A deck that builds its slides on `DOMContentLoaded`, so the form does
 *     not exist when a one-shot `querySelectorAll` runs.
 *
 * Both engines are bound in the BUBBLE phase, as the originals are. That is
 * what the runtime's form-root shield stops. A deck binding `capture: true`
 * on `document` would still win — the same residual the annotation overlay
 * card has always had, documented in viewer/forms-runtime.ts.
 */

/**
 * Verbatim from `2026-07-05-architecture-de-marque/index.html` (the `go`
 * function, the `document` keydown listener and the `#deck` click listener),
 * with the progress-bar/dot chrome dropped because nothing here asserts on
 * it. Never "clean this up": its value is being unmodified.
 */
const ARCHITECTURE_DE_MARQUE_ENGINE = `
  const slides=[...document.querySelectorAll('.slide')];
  let i=0;
  function go(n){
    i=Math.max(0,Math.min(slides.length-1,n));
    slides.forEach((s,k)=>s.classList.toggle('active',k===i));
    document.getElementById('count').textContent=String(i+1);
  }
  document.addEventListener('keydown',e=>{
    if(e.key==='ArrowRight'||e.key===' '||e.key==='PageDown'){go(i+1);e.preventDefault();}
    if(e.key==='ArrowLeft'||e.key==='PageUp'){go(i-1);e.preventDefault();}
    if(e.key==='Home')go(0); if(e.key==='End')go(slides.length-1);
  });
  document.getElementById('deck').addEventListener('click',e=>{
    if(e.target.closest('.dot')||e.target.closest('a'))return;
    const x=e.clientX/window.innerWidth; go(x>0.5?i+1:i-1);
  });
  go(0);
`;

/**
 * Verbatim in shape from `2026-04-22-reb-app-analysis/presentation.html`:
 * digit hotkeys on `document` keydown, and the start-up
 * `history.replaceState(null,'','#slide=1')` that wipes the arrival
 * fragment. That replaceState is the whole point of this fixture.
 */
const REB_HASH_ENGINE = `
  const slides=[...document.querySelectorAll('.slide')];
  let current=0;
  function switchTab(index,skipHash){
    if(index<0||index>=slides.length)return;
    slides[current].classList.remove('active');
    current=index;
    slides[current].classList.add('active');
    document.getElementById('count').textContent=String(current+1);
    if(!skipHash){history.replaceState(null,'','#slide='+(current+1));}
  }
  function getSlideFromHash(){
    const match=location.hash.match(/slide=(\\d+)/);
    if(match)return Math.max(0,Math.min(parseInt(match[1])-1,slides.length-1));
    return 0;
  }
  const initialSlide=getSlideFromHash();
  if(initialSlide>0){current=-1;switchTab(initialSlide,true);}
  else{history.replaceState(null,'','#slide=1');}
  document.addEventListener('keydown',(e)=>{
    const key=e.key;
    if(key>='1'&&key<='7'){e.preventDefault();switchTab(parseInt(key)-1);}
    if(key==='ArrowDown'||key==='ArrowRight'){e.preventDefault();switchTab(current+1);}
    if(key==='ArrowUp'||key==='ArrowLeft'){e.preventDefault();switchTab(current-1);}
  });
  slides[0].classList.add('active');
`;

const DECK_CSS = `
  html,body{margin:0;font-family:system-ui,sans-serif}
  #deck{min-height:100vh}
  .slide{display:none;padding:24px}
  .slide.active{display:block}
  #count{position:fixed;top:4px;right:8px;font:12px monospace}
`;

function page(title: string, slides: string[], engine: string, extraHead = '', lang = ''): string {
  return [
    `<!doctype html><html${lang ? ` lang="${lang}"` : ''}><head><meta charset="utf-8"><title>${title}</title>`,
    `<style>${DECK_CSS}</style>${extraHead}</head><body>`,
    '<div id="count">1</div>',
    '<div id="deck">',
    ...slides.map((s, n) => `<section class="slide" data-slide="${n + 1}">${s}</section>`),
    '</div>',
    `<script>${engine}</script>`,
    '</body></html>'
  ].join('\n');
}

export const REALDECK_SUCCESS = 'Merci, votre réponse est enregistrée.';

/**
 * Fixture 1 — architecture-de-marque: the form sits on slide 2, so any
 * stray navigation HIDES it and every assertion below can tell.
 */
export const ARCHITECTURE_DECK_HTML = page(
  'Architecture de marque (e2e)',
  [
    '<h1>Architecture de marque</h1><p>Slide one.</p>',
    [
      '<h2>Restons en contact</h2>',
      `<form data-slideless-form="contact" data-slideless-success="${REALDECK_SUCCESS}">`,
      '  <input id="f-name" name="name" placeholder="Votre nom">',
      '  <input id="f-mail" name="email" placeholder="vous@exemple.be">',
      '  <button id="f-send" type="submit">Envoyer</button>',
      '</form>'
    ].join('\n'),
    '<h2>Slide three</h2>'
  ],
  ARCHITECTURE_DE_MARQUE_ENGINE
);

/**
 * Fixture 2 — TWO forms on ONE slide, the cross-form corruption habitat
 * (§4 item 2). One module-level `editSecret` plus own-row routes with no
 * form segment meant editing `salary` filed the correction under `public`
 * and destroyed that answer, while the card said "updated".
 */
export const TWO_FORMS_DECK_HTML = page(
  'Two forms (e2e)',
  [
    '<h1>Intro</h1>',
    [
      '<h2>Both at once</h2>',
      '<form data-slideless-form="public">',
      '  <input id="pub-note" name="note" placeholder="public note">',
      '  <button id="pub-send" type="submit">Send public</button>',
      '</form>',
      '<form data-slideless-form="salary">',
      '  <input id="sal-amount" name="amount" placeholder="salary">',
      '  <button id="sal-send" type="submit">Send salary</button>',
      '</form>'
    ].join('\n')
  ],
  ARCHITECTURE_DE_MARQUE_ENGINE
);

/**
 * Fixture 2b — a FRENCH deck (PRDCT-2344): `<html lang="fr">` and nothing
 * else on form `fr`, so every built-in string of its dialog must come out
 * French; form `xx` declares a language the catalogue lacks and overrides
 * one string with markup in it, so it must come out English with that
 * override shown as the characters typed. Same hostile engine as fixture 1.
 */
export const FRENCH_OVERRIDE = '<b>Copier</b> le lien';
export const FRENCH_DECK_HTML = page(
  'Deck en français (e2e)',
  [
    '<h1>Bonjour</h1>',
    [
      '<h2>Deux formulaires</h2>',
      '<form data-slideless-form="fr">',
      '  <input id="fr-note" name="note" placeholder="note">',
      '  <button id="fr-send" type="submit">Envoyer</button>',
      '</form>',
      `<form data-slideless-form="xx" data-slideless-lang="xx-YY" data-slideless-text-copy="${FRENCH_OVERRIDE}">`,
      '  <input id="xx-note" name="note" placeholder="note">',
      '  <button id="xx-send" type="submit">Send</button>',
      '</form>'
    ].join('\n')
  ],
  ARCHITECTURE_DE_MARQUE_ENGINE,
  '',
  'fr'
);

/**
 * Fixture 3 — reb-app-analysis: `history.replaceState` wipes `#slr=` at
 * start-up, and digits are hotkeys so typing an email used to jump slides.
 */
export const HASH_DECK_HTML = page(
  'Hash-normalizing deck (e2e)',
  [
    '<h1>Analyse</h1>',
    [
      '<h2>Votre avis</h2>',
      '<form data-slideless-form="avis">',
      '  <input id="f-mail" name="email" placeholder="vous@exemple.be">',
      '  <button id="f-send" type="submit">Envoyer</button>',
      '</form>'
    ].join('\n')
  ],
  REB_HASH_ENGINE
);

/**
 * Fixture 4 — the form does not exist at injection time: the deck renders
 * its slides on `DOMContentLoaded`. A one-shot `querySelectorAll` misses it
 * and the native submit garbage-navigates the sandbox with the answers in
 * the query string, storing nothing (§4 item 3).
 */
export const LATE_DECK_HTML = [
  '<!doctype html><html><head><meta charset="utf-8"><title>Late deck (e2e)</title>',
  `<style>${DECK_CSS}</style></head><body>`,
  '<div id="count">1</div><div id="deck"></div>',
  '<script>',
  "document.addEventListener('DOMContentLoaded', function () {",
  "  document.getElementById('deck').innerHTML =",
  '    \'<section class="slide active"><h2>Late</h2>\' +',
  '    \'<form data-slideless-form="late"><input id="f-note" name="note">\' +',
  '    \'<button id="f-send" type="submit">Send</button></form></section>\';',
  '});',
  '</script>',
  '</body></html>'
].join('\n');

/**
 * Fixture 5 — the EXTERNAL BUNDLE (PRDCT-1331/1334 residual): the page
 * carries no marker at all; `app.js` renders the slides, the form included,
 * on `DOMContentLoaded`, the way a build tool outputs a deck. Commit-time
 * detection that read only HTML entries stamped this deck form-less: the
 * runtime never arrived and the native submit stored nothing. Fixture 4
 * could not catch it because its late-render script is INLINE.
 */
export const BUNDLE_DECK_INDEX_HTML = [
  '<!doctype html><html><head><meta charset="utf-8"><title>Bundled deck (e2e)</title>',
  `<style>${DECK_CSS}</style></head><body>`,
  '<div id="count">1</div><div id="deck"></div>',
  '<script src="app.js"></script>',
  '</body></html>'
].join('\n');

export const BUNDLE_DECK_APP_JS = [
  "document.addEventListener('DOMContentLoaded', function () {",
  "  document.getElementById('deck').innerHTML =",
  '    \'<section class="slide active"><h2>Bundled</h2>\' +',
  '    \'<form data-slideless-form="bundled"><input id="f-note" name="note">\' +',
  '    \'<button id="f-send" type="submit">Send</button></form></section>\';',
  '});'
].join('\n');
