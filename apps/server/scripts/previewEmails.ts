/**
 * Render every transactional email to static HTML for local review.
 *
 * The output is one page showing every rendering at once: each message sits in
 * a little mail-client plate (window chrome, subject, sender, then the real
 * email), plates are bounded into a box per category, and an ⓘ next to each
 * name explains when that email lands in someone's inbox.
 *
 * Same wall as the platform/dashboard/saas/site-cms templates and the hub (they
 * are one family; change one, consider the others), reduced to a single
 * language because these builders are English-only today. `WALL_LANGS` is where
 * a second language plugs in when the builders learn one.
 *
 * Files land in `.tmp/email-previews/`:
 *   <template>--<variant>.<lang>.html   the rendered email
 *   index.html                          the wall
 *
 * Nothing is sent — no provider call anywhere in this script.
 *
 * Add a new email:
 *   1. Export its builder (account mails: the chassis's `email/templates.ts`; deck mails:
 *      `src/email/deck-templates.ts`) — builders stay
 *      env-free (urls, names, dates arrive as parameters), which is what lets
 *      `tsx` render them standalone
 *   2. Add a TemplateSpec to `catalogue(lang)` with reader-facing `when` copy
 *   3. Give it one variant per shape worth reviewing
 *
 * Usage:
 *   pnpm preview:emails         (from apps/server)
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  buildChangeEmailConfirmEmail,
  buildInviteEmail,
  buildOtpEmail,
  buildPasswordResetEmail,
  buildVerifyEmailEmail,
  setEmailAssets
} from '@antasphere/chassis-server/email';
import { MAIL_BRAND, MAIL_COPY } from '../src/email/brand.js';
import {
  buildCollaboratorInviteEmail,
  buildFormResponseEditedEmail,
  buildFormResponseEmail,
  buildResponseLinkEmail,
  buildShareEmail
} from '../src/email/deck-templates.js';

const PRODUCT_NAME = MAIL_BRAND.name;
/** What boot hands the five account mails: the brand, and the invitation's two phrases. */
const brand = MAIL_BRAND;
const inviteWords = { pitch: MAIL_COPY.invitePitch, preheader: MAIL_COPY.invitePreheader };

type Lang = 'en';

/** The wall speaks whatever languages the builders do. */
const WALL_LANGS: Lang[] = ['en'];
const LANG_LABEL: Record<Lang, string> = { en: 'English' };

/** Catalogue sections, in reading order. */
const CATEGORIES = ['access', 'sharing', 'forms'] as const;
type Category = (typeof CATEGORIES)[number];

/** A string in every language the wall speaks. */
type Text = Record<Lang, string>;

const CATEGORY_TITLE: Record<Category, Text> = {
  access: { en: 'Access & sign-in' },
  sharing: { en: 'Sharing a deck' },
  forms: { en: 'Form activity' }
};

/** Popover label above the "when" copy. */
const WHEN_LABEL: Text = { en: 'When' };

// ─── Shapes ──────────────────────────────────────────────────────────

/** One rendering of a template — a distinct shape worth eyeballing. */
interface Variant {
  id: string;
  /** Short label appended to the name; '' when there is only one. */
  label: Text;
  /** Overrides the template's `when` when this shape has its own story. */
  when?: Text;
  /** Not rendered — the plate shows the sender. Kept as a maintainer note. */
  to: string;
  attachments?: string[];
  subject: string;
  html: string;
  plaintext?: string;
}

interface TemplateSpec {
  id: string;
  name: Text;
  category: Category;
  /**
   * WHEN this lands in someone's inbox, in one or two plain sentences. Written
   * for whoever reviews the copy — no function names, no internals. This is
   * what the ⓘ next to each plate shows.
   */
  when: Text;
  /** Dev pointer, not rendered. */
  source: string;
  variants: Variant[];
}

const BASE_URL = 'https://slideless.antasphere.com';
const VIEWER_URL = 'https://view.slideless.antasphere.com';
// The real From line is environment configuration (EMAIL_FROM); Slideless sends
// every class from one sender today, so the wall shows that single shape.
const SENDER = `${PRODUCT_NAME} <noreply@slideless.antasphere.com>`;
const USER_EMAIL = 'alex@example.com';

function catalogue(lang: Lang): TemplateSpec[] {
  void lang; // single-language today; the parameter is the growth path
  const only: Text = { en: '' };
  const inOneHour = new Date('2026-01-15T15:00:00Z');
  const inSevenDays = new Date('2026-01-22T14:00:00Z');
  const justNow = new Date('2026-01-15T14:00:00Z');

  return [
    {
      id: 'otp',
      name: { en: 'One-time code' },
      category: 'access',
      when: {
        en: 'On every email-code sign-in, browser or CLI. The user enters their address, this code lands in their inbox and lets them in. Self-hosted instances only — on the cloud, sign-in goes through the Antasphere account.'
      },
      source: 'src/email/templates.ts',
      variants: [
        {
          id: 'sign-in',
          label: only,
          to: USER_EMAIL,
          ...buildOtpEmail({ brand, otp: '482193', type: 'sign-in' })
        }
      ]
    },
    {
      id: 'invite',
      name: { en: 'Workspace invitation' },
      category: 'access',
      when: {
        en: 'When a member invites someone into a workspace. The invitation exists before the email does, and the same link stays copyable from the app — with no mail driver configured, that copyable link is the whole flow.'
      },
      source: 'src/email/templates.ts',
      variants: [
        {
          id: 'default',
          label: only,
          to: 'new.member@example.com',
          ...buildInviteEmail({
            brand,
            ...inviteWords,
            inviteeEmail: 'new.member@example.com',
            inviterName: 'Nora Okafor',
            workspaceName: 'Acme Studio',
            acceptUrl: `${BASE_URL}/invitations/accept?token=inv_9f27c4`,
            expiresAt: inSevenDays
          })
        }
      ]
    },
    {
      id: 'password-reset',
      name: { en: 'Password reset' },
      category: 'access',
      when: {
        en: 'When someone asks for a password reset from the login page. The link opens the choose-a-new-password screen; an unrequested one is safe to ignore. Self-hosted instances only.'
      },
      source: 'src/email/templates.ts',
      variants: [
        {
          id: 'default',
          label: only,
          to: USER_EMAIL,
          ...buildPasswordResetEmail({
            brand,
            resetUrl: `${BASE_URL}/reset-password?token=rst_5b81aa`,
            expiresAt: inOneHour
          })
        }
      ]
    },
    {
      id: 'change-email-confirm',
      name: { en: 'Email change — confirm' },
      category: 'access',
      when: {
        en: 'To the OLD address when a verified user asks to change their email. Leg one of two: confirming here triggers the verification email to the new address.'
      },
      source: 'src/email/templates.ts',
      variants: [
        {
          id: 'default',
          label: only,
          to: USER_EMAIL,
          ...buildChangeEmailConfirmEmail({
            brand,
            newEmail: 'alex.new@example.com',
            confirmUrl: `${BASE_URL}/account/change-email/confirm?token=chg_e3d901`,
            expiresAt: inOneHour
          })
        }
      ]
    },
    {
      id: 'verify-email',
      name: { en: 'Email change — verify' },
      category: 'access',
      when: {
        en: 'To the NEW address: the final leg of every email change (and any plain verification). The address becomes the account email once this link is opened.'
      },
      source: 'src/email/templates.ts',
      variants: [
        {
          id: 'default',
          label: only,
          to: 'alex.new@example.com',
          ...buildVerifyEmailEmail({
            brand,
            verifyUrl: `${BASE_URL}/account/verify-email?token=vrf_71c2b8`,
            expiresAt: inOneHour
          })
        }
      ]
    },
    {
      id: 'collaborator-invite',
      name: { en: 'Deck collaborator invitation' },
      category: 'access',
      when: {
        en: 'When someone is invited to collaborate on ONE deck rather than to join the workspace. The recipient can push new versions of that deck and manage its share links, nothing else. The link in this email is only ever sent by mail — the inviter never sees it — so opening it proves the recipient owns the mailbox.'
      },
      source: 'src/email/templates.ts',
      variants: [
        {
          id: 'default',
          label: only,
          to: 'dana@example.com',
          ...buildCollaboratorInviteEmail({
            inviteeEmail: 'dana@example.com',
            inviterName: 'Nora Okafor',
            presentationTitle: 'Q4 Product Review',
            claimUrl: `${BASE_URL}/collaborate/claim?token=col_2b8d1f`,
            expiresAt: inSevenDays
          })
        }
      ]
    },
    {
      id: 'share',
      name: { en: 'A deck was shared with you' },
      category: 'sharing',
      when: {
        en: 'When someone shares a presentation by email from the app. Each recipient gets their own link, personal to them, which opens the deck in the viewer. The sender can add a note, set an expiry and put a password on the link.'
      },
      source: 'src/email/templates.ts',
      variants: [
        {
          id: 'full',
          label: { en: 'note, password, expiry' },
          when: {
            en: 'The richest shape: the sender wrote a note, put a password on the link and gave it an expiry date. The password itself never travels in the email — the sender passes it on separately.'
          },
          to: 'dana@example.com',
          ...buildShareEmail({
            senderName: 'Nora Okafor',
            presentationTitle: 'Q4 Product Review',
            viewerUrl: `${VIEWER_URL}/v/9d4c1a7b2e`,
            message: 'Here is the deck from this morning — slide 12 is the one we argued about.',
            expiresAt: inSevenDays,
            hasPassword: true
          })
        },
        {
          id: 'bare',
          label: { en: 'link only' },
          when: {
            en: 'The plainest shape: no note, no password, no expiry. Worth reviewing beside the full one — the optional parts must leave no holes when they are absent.'
          },
          to: 'dana@example.com',
          ...buildShareEmail({
            senderName: 'Nora Okafor',
            presentationTitle: 'Q4 Product Review',
            viewerUrl: `${VIEWER_URL}/v/9d4c1a7b2e`,
            message: undefined,
            expiresAt: undefined,
            hasPassword: false
          })
        }
      ]
    },
    {
      id: 'form-response',
      name: { en: 'New form response' },
      category: 'forms',
      when: {
        en: 'To the deck owner when someone answers a form embedded in their deck, if they have these notices switched on for that deck. It says a response arrived and where to read it — never the answers themselves, which stay in the product.'
      },
      source: 'src/email/templates.ts',
      variants: [
        {
          id: 'quiet',
          label: { en: 'first in a while' },
          when: {
            en: 'The ordinary shape: one response arrived and nothing was held back since the previous notice.'
          },
          to: USER_EMAIL,
          ...buildFormResponseEmail({
            presentationTitle: 'Q4 Product Review',
            formName: 'feedback',
            shareTokenName: 'Board — October',
            at: justNow,
            deckUrl: `${BASE_URL}/decks/9d4c1a7b/responses`,
            pendingNew: 0,
            pendingEdited: 0
          })
        },
        {
          id: 'pending',
          label: { en: 'with held-back activity' },
          when: {
            en: 'These notices are spaced out per deck, so a busy form does not flood an inbox. Whatever happened in the quiet window is counted and carried by the next email, so nothing goes unsaid.'
          },
          to: USER_EMAIL,
          ...buildFormResponseEmail({
            presentationTitle: 'Q4 Product Review',
            formName: 'feedback',
            shareTokenName: 'Board — October',
            at: justNow,
            deckUrl: `${BASE_URL}/decks/9d4c1a7b/responses`,
            pendingNew: 3,
            pendingEdited: 1
          })
        },
        {
          id: 'deleted-link',
          label: { en: 'through a deleted link' },
          when: {
            en: 'The response came through a share link that has since been deleted. The notice says so rather than naming a link the owner can no longer find.'
          },
          to: USER_EMAIL,
          ...buildFormResponseEmail({
            presentationTitle: 'Q4 Product Review',
            formName: 'feedback',
            shareTokenName: null,
            at: justNow,
            deckUrl: `${BASE_URL}/decks/9d4c1a7b/responses`,
            pendingNew: 0,
            pendingEdited: 0
          })
        }
      ]
    },
    {
      id: 'form-response-edited',
      name: { en: 'Form response edited' },
      category: 'forms',
      when: {
        en: 'To the deck owner when an answer already given is changed. A separate email from the new-response one on purpose: "an answer changed" is a different signal from "an answer arrived". Earlier revisions are kept and the owner can read the history in the product.'
      },
      source: 'src/email/templates.ts',
      variants: [
        {
          id: 'default',
          label: only,
          to: USER_EMAIL,
          ...buildFormResponseEditedEmail({
            presentationTitle: 'Q4 Product Review',
            formName: 'feedback',
            shareTokenName: 'Board — October',
            at: justNow,
            deckUrl: `${BASE_URL}/decks/9d4c1a7b/responses`,
            pendingNew: 0,
            pendingEdited: 2,
            revision: 3
          })
        }
      ]
    },
    {
      id: 'response-link',
      name: { en: 'Your form response' },
      category: 'forms',
      when: {
        en: 'To the person who answered a form, when they asked for a copy of their own link (or are signed in and recognised). It carries one personal link that opens their own answer for review or update — anyone holding it can edit that one response, so the email says to treat it like a password.'
      },
      source: 'src/email/templates.ts',
      variants: [
        {
          id: 'default',
          label: only,
          to: 'dana@example.com',
          ...buildResponseLinkEmail({
            editUrl: `${VIEWER_URL}/v/9d4c1a7b2e/r/8f2e#k=1a7c9d4b2e6f`
          })
        }
      ]
    }
  ];
}

// ─── Index payload ───────────────────────────────────────────────────
// Emails are AUTHORED as templates + variants (the honest shape of the code)
// but DISPLAYED flat, one plate per rendering, so the whole set is on screen
// at once.
//
// The payload is keyed BY PLATE, with every language nested inside, rather
// than one wall per language. That is what lets the page build every language
// once and switch by toggling visibility: no iframe is ever torn down, so
// changing language cannot reload a document, re-flash its webfonts, or
// re-measure.
//
// The rendered HTML travels inline and reaches each iframe through `srcdoc`
// rather than `src`, which is what lets the wall append a measuring script
// while the files on disk stay byte-for-byte the email.

/** One rendering in one language. Short keys — this ships once per plate per language. */
interface CardLang {
  /** subject */ s: string;
  /** attachments */ a: string[];
  /** html */ h: string;
  /** plate title */ t: string;
  /** the ⓘ copy: when this lands in someone's inbox */ w: string;
}

interface Card {
  id: string;
  l: Record<Lang, CardLang>;
}

interface Section {
  /** Localized section heading. */
  title: Text;
  cards: Card[];
}

const fileFor = (t: string, v: string, lang: Lang) => `${t}--${v}.${lang}`;

/**
 * Zip the per-language catalogues into one plate-keyed tree. The catalogues
 * are structurally identical by construction, and this throws if that ever
 * stops being true rather than silently pairing one language's subject with
 * another's body.
 */
function toSections(byLang: Record<Lang, TemplateSpec[]>): Section[] {
  const base = byLang[WALL_LANGS[0]!]!;

  for (const lang of WALL_LANGS.slice(1)) {
    const other = byLang[lang]!;
    const same =
      other.length === base.length &&
      base.every((t, i) => other[i]!.id === t.id && other[i]!.variants.length === t.variants.length);
    if (!same) {
      throw new Error(
        `catalogue(${lang}) does not match catalogue(${WALL_LANGS[0]}) — the wall pairs them by position`
      );
    }
  }

  return CATEGORIES.map((category) => {
    const cards: Card[] = [];
    base.forEach((t, ti) => {
      if (t.category !== category) return;
      t.variants.forEach((v, vi) => {
        const l = {} as Record<Lang, CardLang>;
        for (const lang of WALL_LANGS) {
          const lv = byLang[lang]![ti]!.variants[vi]!;
          const label = v.label[lang];
          l[lang] = {
            s: lv.subject,
            a: lv.attachments ?? [],
            h: lv.html,
            t: label ? `${t.name[lang]} — ${label}` : t.name[lang],
            // A variant only overrides the story when its shape has its own.
            w: (v.when ?? t.when)[lang]
          };
        }
        cards.push({ id: `${t.id}--${v.id}`, l });
      });
    });
    return { title: CATEGORY_TITLE[category], cards };
  }).filter((s) => s.cards.length > 0);
}

function renderIndex(sections: Section[], counts: { cards: number }): string {
  // `<` is escaped so an email body containing "</script>" cannot break out.
  const payload = JSON.stringify(sections).replace(/</g, '\\u003c');

  const langButtons = WALL_LANGS.map(
    (l) =>
      `<button class="lang" data-lang="${l}"${l === WALL_LANGS[0] ? ' aria-current="true"' : ''} title="${escapeAttr(LANG_LABEL[l])}">${l.toUpperCase()}</button>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(PRODUCT_NAME)} — email previews</title>
  <link rel="preconnect" href="https://api.fontshare.com">
  <link rel="stylesheet" href="https://api.fontshare.com/v2/css?f%5B%5D=cabinet-grotesk@500,700&f%5B%5D=synonym@400,500&display=swap">
  <style>
    :root {
      --fg: #1C1915;
      --fg-dim: rgba(28, 25, 21, 0.58);
      --edge: rgba(28, 25, 21, 0.13);
      --ink: #1C1915;
      --muted: #6E6759;
      --hairline: #E4DECF;
      --ui: 'Synonym', system-ui, -apple-system, sans-serif;
      --display: 'Cabinet Grotesk', Georgia, serif;
      --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    }
    html { color-scheme: light; }
    *, *::before, *::after { box-sizing: border-box; }

    /* No rubber-band: the bar is fixed, and an overscrolling document would
       still slide the page out from under it on macOS. */
    html, body { overscroll-behavior: none; }

    body {
      margin: 0; padding-top: 48px;
      background: #ECE4D6; color: var(--fg);
      font-family: var(--ui); line-height: 1.5;
    }

    /* The grain field: a blurred blob gradient with a film-grain tile
       composited over it in "overlay". */
    #field { position: fixed; inset: 0; z-index: -1; display: block; pointer-events: none; }

    .wrap { max-width: 1400px; margin: 0 auto; padding: 0 24px; }

    /* Fixed, not sticky — a sticky bar still rides the rubber-band. */
    .topbar {
      position: fixed; top: 0; left: 0; right: 0; height: 48px; z-index: 20;
      background: rgba(250, 247, 240, 0.82);
      backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--edge);
    }
    .topbar__in { display: flex; align-items: center; gap: 14px; height: 48px; }
    .wordmark { font-family: var(--display); font-weight: 500; font-size: 18px; letter-spacing: -0.03em; }
    .count { font-family: var(--mono); font-size: 10px; letter-spacing: 0.13em; text-transform: uppercase; color: var(--fg-dim); flex: 1; }

    .langs { display: flex; gap: 2px; padding: 3px; background: rgba(27, 42, 51, 0.07); border-radius: 8px; }
    .lang {
      font-family: var(--mono); font-size: 11px; letter-spacing: 0.12em;
      padding: 5px 12px; border: 0; border-radius: 5px; cursor: pointer;
      background: transparent; color: var(--fg-dim);
    }
    .lang:hover { color: var(--fg); }
    .lang[aria-current="true"] { background: var(--fg); color: #F7F4EC; }

    /* One bounded box per nature of email. */
    .section {
      margin: 26px 0 0;
      border: 1px solid var(--edge); border-radius: 12px;
      background: rgba(255, 255, 255, 0.34);
      padding: 18px;
    }
    .section > h2 {
      font-family: var(--display); font-weight: 700; font-size: 25px;
      letter-spacing: -0.025em; margin: 0 0 16px;
    }

    /* Default "stretch" is what makes side-by-side plates share a height. */
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(520px, 1fr)); gap: 16px; }

    .mail {
      position: relative;              /* the ⓘ popover anchors inside this */
      display: flex; flex-direction: column; height: 100%;
      background: #fff; border-radius: 8px; color: var(--ink);
      /* No overflow:hidden here — it would clip the popover. The stage clips
         its own frame instead, and the chrome rounds its own top corners. */
      border: 1px solid rgba(27, 42, 51, 0.12);
      box-shadow: 0 2px 10px rgba(27, 42, 51, 0.07);
    }
    /* Raised so an open popover is never painted under a neighbouring plate. */
    .mail:hover { z-index: 5; }
    .mail__chrome {
      flex: none; display: flex; align-items: center; gap: 9px;
      padding: 8px 12px; background: #F4F1EA; border-bottom: 1px solid var(--hairline);
      border-radius: 8px 8px 0 0;
    }
    .dots { display: flex; gap: 5px; }
    .dots i { width: 9px; height: 9px; border-radius: 50%; background: #DCD5C6; }
    .mail__name { font-size: 11.5px; color: var(--muted); }

    /* The ⓘ and its floating box. Hover or keyboard focus opens it; it is
       deliberately a small paragraph with room to breathe, not a tooltip. */
    .hint { position: relative; display: inline-flex; }
    .hint__btn {
      width: 15px; height: 15px; padding: 0; border-radius: 50%; cursor: help;
      display: grid; place-items: center;
      border: 1px solid rgba(27, 42, 51, 0.28); background: transparent;
      font-family: var(--ui); font-size: 10px; font-weight: 600; line-height: 1;
      color: var(--muted);
    }
    .hint__btn:hover { border-color: var(--ink); color: var(--ink); }
    .hint__btn:focus-visible { outline: 2px solid #4A7A99; outline-offset: 2px; }

    .hint__pop {
      position: absolute; top: calc(100% + 10px); left: -7px; z-index: 60;
      width: 320px; padding: 16px 18px 17px; text-align: left;
      background: #fff; border: 1px solid rgba(27, 42, 51, 0.13); border-radius: 10px;
      box-shadow: 0 12px 34px rgba(27, 42, 51, 0.17);
      opacity: 0; visibility: hidden; transform: translateY(-4px);
      transition: opacity .14s ease, transform .14s ease, visibility .14s;
    }
    /* :focus, not :focus-visible — the latter is a browser heuristic that does
       not fire for every way focus can land on the button, and this box has to
       be reachable without a mouse. The ring below stays :focus-visible. */
    .hint:hover .hint__pop,
    .hint__btn:focus + .hint__pop { opacity: 1; visibility: visible; transform: none; }
    /* A little bridge over the gap, so the box survives the trip to it. */
    .hint__pop::before { content: ''; position: absolute; top: -12px; left: 0; right: 0; height: 12px; }
    /* Both are spans inside a span — without display:block the label would sit
       on the same line as the sentence and the margin would do nothing. */
    .hint__label {
      display: block; font-family: var(--mono); font-size: 9px; letter-spacing: 0.17em;
      text-transform: uppercase; color: #8A9298; margin-bottom: 9px;
    }
    .hint__text { display: block; font-size: 13px; line-height: 1.6; color: #3D4A52; }

    /* Grows with the subject rather than clipping it. */
    .mail__head {
      flex: none; padding: 12px 14px 13px; background: #FCFAF6;
      border-bottom: 1px solid var(--hairline);
    }
    .mail__subject {
      font-size: 15px; font-weight: 600; color: var(--ink); line-height: 1.34;
    }
    .mail__from {
      margin-top: 5px; font-family: var(--mono); font-size: 11px; line-height: 1.45;
      color: var(--muted); overflow-wrap: anywhere;
    }

    /* The stage takes the leftover height of the row and centres the message
       in it, so a short email in a tall row floats rather than sitting on
       top. */
    .mail__stage { position: relative; flex: 1; min-height: 0; background: #f1ede1; overflow: hidden; border-radius: 0 0 8px 8px; }
    .mail__stage iframe {
      position: absolute; left: 0; width: 100%; border: 0;
      top: 50%; transform: translateY(-50%);
      height: 620px;               /* median email, until the frame reports back */
      visibility: hidden;
    }
    .mail__stage iframe.on { visibility: visible; }

    footer { padding: 26px 0 34px; font-family: var(--mono); font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--fg-dim); }

    @media (max-width: 620px) {
      .wrap { padding: 0 12px; }
      .section { padding: 12px; }
      .grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <canvas id="field" aria-hidden="true"></canvas>

  <header class="topbar">
    <div class="wrap topbar__in">
      <span class="wordmark">${escapeHtml(PRODUCT_NAME)}</span>
      <span class="count">${counts.cards} emails</span>
      <div class="langs" role="group" aria-label="Language">${langButtons}</div>
    </div>
  </header>

  <div class="wrap">
    <div id="sections"></div>
    <footer>// generated ${new Date().toISOString()}</footer>
  </div>

  <script>
    const SECTIONS = ${payload};
    const WHEN_LABEL = ${JSON.stringify(WHEN_LABEL)};
    const FROM = ${JSON.stringify(SENDER)};
    const WALL_LANGS = ${JSON.stringify(WALL_LANGS)};
    let lang = WALL_LANGS[0];

    const esc = (s) => String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    /* ── grain field ─────────────────────────────────────────────── */
    const BASE = '#ECE4D6';
    const BLOBS = [
      { x: 0.12, y: 0.14, r: 0.56, color: '#F6F0E4', alpha: 0.85 },
      { x: 0.86, y: 0.10, r: 0.48, color: '#D9C6AC', alpha: 0.68 },
      { x: 0.68, y: 0.76, r: 0.60, color: '#E3D3BC', alpha: 0.72 },
      { x: 0.24, y: 0.86, r: 0.54, color: '#CDB89B', alpha: 0.60 },
      { x: 0.52, y: 0.42, r: 0.44, color: '#FAF6EE', alpha: 0.55 },
      { x: 0.97, y: 0.58, r: 0.38, color: '#C2A985', alpha: 0.60 }
    ];

    function noiseTile(size, amp) {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const ctx = c.getContext('2d');
      const img = ctx.createImageData(size, size);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const v = 128 + (Math.random() - 0.5) * 255 * amp;
        d[i] = d[i + 1] = d[i + 2] = v;
        d[i + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      return c;
    }
    const GRAIN = noiseTile(512, 0.9);

    function paintField() {
      const canvas = document.getElementById('field');
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = Math.round(window.innerWidth * dpr);
      const H = Math.round(window.innerHeight * dpr);
      if (!W || !H) return;
      canvas.width = W; canvas.height = H;
      canvas.style.width = window.innerWidth + 'px';
      canvas.style.height = window.innerHeight + 'px';
      const ctx = canvas.getContext('2d');

      const lw = 120, lh = Math.max(8, Math.round(120 * H / W));
      const low = document.createElement('canvas');
      low.width = lw; low.height = lh;
      const c = low.getContext('2d');
      c.fillStyle = BASE; c.fillRect(0, 0, lw, lh);
      for (const b of BLOBS) {
        const x = b.x * lw, y = b.y * lh, r = b.r * lw;
        const g = c.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, b.color);
        g.addColorStop(1, b.color + '00');
        c.fillStyle = g; c.globalAlpha = b.alpha;
        c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
        c.globalAlpha = 1;
      }

      ctx.clearRect(0, 0, W, H);
      ctx.imageSmoothingQuality = 'high';
      ctx.filter = 'blur(' + Math.max(4, Math.round(W * 0.018)) + 'px)';
      ctx.drawImage(low, -W * 0.06, -H * 0.06, W * 1.12, H * 1.12);
      ctx.filter = 'none';

      ctx.save();
      ctx.globalCompositeOperation = 'overlay';
      ctx.globalAlpha = 0.14;
      const pat = ctx.createPattern(GRAIN, 'repeat');
      pat.setTransform(new DOMMatrix().scale(dpr));
      ctx.fillStyle = pat;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
    let ft = null;
    addEventListener('resize', () => { clearTimeout(ft); ft = setTimeout(paintField, 140); });
    paintField();

    /* ── the wall ────────────────────────────────────────────────── */
    // Injected into each srcdoc so the frame can report its natural height.
    // Measures the BODY BOX, not documentElement.scrollHeight — the latter
    // cannot report less than the iframe's own viewport, so every email
    // shorter than the frame would come back as exactly the default height.
    // Split so the literal closing script tag never appears in this document.
    const MEASURE =
      '<scr' + 'ipt>(function(){var p=function(){parent.postMessage(' +
      '{t:"h",h:Math.ceil(document.body.getBoundingClientRect().height)},"*")};' +
      'addEventListener("load",p);setTimeout(p,200);setTimeout(p,800);})()</scr' + 'ipt>';

    /** cardId -> { en: h } */
    const heights = {};

    // Build the whole wall ONCE, every language included. Switching later only
    // flips a class and swaps text, so no frame is ever reloaded.
    function build() {
      let html = '';
      SECTIONS.forEach((s, si) => {
        html += '<section class="section" data-si="' + si + '"><h2></h2><div class="grid">';
        for (const c of s.cards) {
          heights[c.id] = {};
          html +=
            '<article class="mail" data-card="' + esc(c.id) + '">' +
              '<div class="mail__chrome">' +
                '<span class="dots"><i></i><i></i><i></i></span>' +
                '<span class="mail__name"></span>' +
                '<span class="hint">' +
                  '<button class="hint__btn" type="button" aria-label="When is this sent?">i</button>' +
                  '<span class="hint__pop" role="tooltip">' +
                    '<span class="hint__label"></span>' +
                    '<span class="hint__text"></span>' +
                  '</span>' +
                '</span>' +
              '</div>' +
              '<div class="mail__head">' +
                '<div class="mail__subject"></div>' +
                '<div class="mail__from"></div>' +
              '</div>' +
              '<div class="mail__stage">' +
                WALL_LANGS.map((l) =>
                  '<iframe data-card="' + esc(c.id) + '" data-lang="' + l + '"' +
                  (l === lang ? ' class="on"' : '') + ' sandbox="allow-scripts"></iframe>'
                ).join('') +
              '</div>' +
            '</article>';
        }
        html += '</div></section>';
      });
      document.getElementById('sections').innerHTML = html;

      // srcdoc is assigned from JS so the email HTML never has to survive
      // attribute escaping.
      const byId = {};
      for (const s of SECTIONS) for (const c of s.cards) byId[c.id] = c;
      for (const f of document.querySelectorAll('.mail__stage iframe')) {
        const h = byId[f.dataset.card].l[f.dataset.lang].h;
        f.srcdoc = h.includes('</body>') ? h.replace('</body>', MEASURE + '</body>') : h + MEASURE;
      }

      applyLang();
    }

    /** Text + visibility for the active language. Never touches srcdoc. */
    function applyLang() {
      const byId = {};
      for (const s of SECTIONS) for (const c of s.cards) byId[c.id] = c;

      SECTIONS.forEach((s, si) => {
        document.querySelector('.section[data-si="' + si + '"] h2').textContent = s.title[lang];
      });

      for (const plate of document.querySelectorAll('.mail')) {
        const c = byId[plate.dataset.card];
        const v = c.l[lang];
        plate.querySelector('.mail__name').textContent = v.t;
        plate.querySelector('.hint__label').textContent = WHEN_LABEL[lang];
        plate.querySelector('.hint__text').textContent = v.w;
        plate.querySelector('.mail__subject').textContent = v.s;
        plate.querySelector('.mail__from').textContent =
          'from ' + FROM + (v.a.length ? '  \\u00b7  \\ud83d\\udcce ' + v.a.join(', ') : '');
        for (const f of plate.querySelectorAll('iframe')) {
          f.classList.toggle('on', f.dataset.lang === lang);
        }
        const h = heights[c.id][lang];
        if (h) plate.querySelector('.mail__stage').style.minHeight = h + 'px';
      }
      document.documentElement.lang = lang;
    }

    addEventListener('message', (e) => {
      const d = e.data;
      if (!d || d.t !== 'h' || !d.h) return;
      for (const f of document.querySelectorAll('.mail__stage iframe')) {
        if (f.contentWindow !== e.source) continue;
        f.style.height = d.h + 'px';
        heights[f.dataset.card][f.dataset.lang] = d.h;
        if (f.dataset.lang === lang) {
          f.closest('.mail').querySelector('.mail__stage').style.minHeight = d.h + 'px';
        }
        return;
      }
    });

    document.querySelector('.langs').addEventListener('click', (ev) => {
      const btn = ev.target.closest('.lang');
      if (!btn || btn.dataset.lang === lang) return;
      lang = btn.dataset.lang;
      for (const b of document.querySelectorAll('.lang')) {
        if (b === btn) b.setAttribute('aria-current', 'true');
        else b.removeAttribute('aria-current');
      }
      applyLang();
    });

    addEventListener('keydown', (ev) => {
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const i = ['1', '2', '3'].indexOf(ev.key);
      if (i > -1 && i < WALL_LANGS.length) {
        const btn = document.querySelector('.lang[data-lang="' + WALL_LANGS[i] + '"]');
        if (btn) btn.click();
      }
    });

    build();
  </script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));

  // A sent mail loads its band and its mark from the instance; the wall inlines
  // the same two files, so it shows the real thing with no server running.
  const asset = (file: string, type: string) =>
    `data:${type};base64,${readFileSync(resolve(here, '../../dashboard/static/email', file)).toString('base64')}`;
  setEmailAssets({ band: asset('band.jpg', 'image/jpeg'), mark: asset('mark.png', 'image/png') });

  const outDir = resolve(here, '..', '.tmp', 'email-previews');
  mkdirSync(outDir, { recursive: true });

  const specsByLang = {} as Record<Lang, TemplateSpec[]>;
  let cards = 0;

  for (const lang of WALL_LANGS) {
    const specs = catalogue(lang);
    specsByLang[lang] = specs;
    cards = 0;
    for (const t of specs) {
      for (const v of t.variants) {
        const base = fileFor(t.id, v.id, lang);
        writeFileSync(resolve(outDir, `${base}.html`), v.html, 'utf8');
        cards++;
      }
    }
  }

  const indexPath = resolve(outDir, 'index.html');
  writeFileSync(indexPath, renderIndex(toSections(specsByLang), { cards }), 'utf8');

  const url = pathToFileURL(indexPath).toString();
  console.log(`\n  ${cards} emails × ${WALL_LANGS.length} language(s) → ${outDir}`);
  console.log(`  Opening ${url}\n`);

  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(opener, [indexPath], { detached: true, stdio: 'ignore' }).unref();
}

main();
