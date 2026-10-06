# Capturing a website's identity

The capture is what makes a brand verifiable: every hex, every weight, every file in the brand
traces back to a screen or an audit line taken here. It runs headless, from a scratch folder
outside the brand folder, and it never touches the instance.

## Setup

A scratch folder with `playwright-core` and the system Chrome (no browser download):

```bash
mkdir -p ~/brand-capture/tidewater/{shots,assets,tools} && cd ~/brand-capture/tidewater/tools
npm init -y >/dev/null && npm i playwright-core >/dev/null
```

`chromium.launch({ channel: 'chrome' })` uses the Chrome already installed. Keep the viewport at
1440 × 900 for every page, so sizes compare across pages and match the site's desktop breakpoint.

## The pages to capture

The home page, every top-level page of the navigation, one detail page of each kind the site has
(one portfolio item, one article, one team member), the pages named brand, press, media kit,
guidelines, and the footer's secondary pages when they carry a different register (a careers page,
an investor page). A site on another host (a blog on a publishing platform) is captured too: it
shows how the company carries the brand onto a surface it does not control.

## The script skeleton

```js
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const PAGES = [
  ['home', 'https://tidewater.example/'],
  ['services', 'https://tidewater.example/services'],
  ['about', 'https://tidewater.example/about']
];

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const audit = {};

for (const [name, url] of PAGES) {
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'networkidle', timeout: 45_000 }).catch(() => {});
  // Scroll the whole page so lazy images and reveal animations have run, then return to the top.
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 600) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 200));
    }
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 800));
  });
  await page.screenshot({ path: `../shots/${name}-viewport.png` });
  await page.screenshot({ path: `../shots/${name}-full.jpg`, fullPage: true, type: 'jpeg', quality: 85 });

  audit[name] = await page.evaluate(() => {
    const count = (m, k) => (m[k] = (m[k] || 0) + 1);
    const fonts = {},
      colors = {},
      backgrounds = {};
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      if (el.textContent.trim()) count(fonts, `${cs.fontFamily.split(',')[0]} | ${cs.fontWeight}`);
      count(colors, cs.color);
      if (cs.backgroundColor !== 'rgba(0, 0, 0, 0)') count(backgrounds, cs.backgroundColor);
      if (cs.backgroundImage.includes('gradient'))
        count(backgrounds, 'gradient: ' + cs.backgroundImage.slice(0, 160));
    }
    const top = (m) =>
      Object.entries(m)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 25);

    // The site's own names for its palette, when it has any.
    const vars = {};
    const faces = [];
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (rule.style)
            for (const p of rule.style)
              if (p.startsWith('--')) vars[p] = rule.style.getPropertyValue(p).trim();
          if (rule instanceof CSSFontFaceRule)
            faces.push(`${rule.style.fontFamily} ${rule.style.fontWeight} ${rule.style.src}`);
        }
      } catch {
        faces.push('cross-origin sheet: ' + sheet.href);
      }
    }

    const headings = [...document.querySelectorAll('h1,h2,h3')].slice(0, 30).map((e) => {
      const cs = getComputedStyle(e);
      return `${e.tagName}: ${e.textContent.trim().slice(0, 80)} // ${cs.fontFamily.split(',')[0]} ${cs.fontWeight} ${cs.fontSize} ${cs.textTransform} ${cs.letterSpacing} ${cs.color}`;
    });
    const brandSvgs = [...document.querySelectorAll('svg')]
      .map((s) => s.outerHTML)
      .filter((h) => /fill="#(?!fff|000)/i.test(h))
      .slice(0, 10);
    const images = [...document.querySelectorAll('img')].map((i) => i.currentSrc || i.src).filter(Boolean);
    const meta = [
      ...document.querySelectorAll('link[rel*="icon"], meta[property^="og:"], meta[name="theme-color"]')
    ].map((m) => m.outerHTML);
    const buttons = [...document.querySelectorAll('a,button')]
      .filter((b) => getComputedStyle(b).backgroundColor !== 'rgba(0, 0, 0, 0)')
      .slice(0, 8)
      .map((b) => {
        const cs = getComputedStyle(b);
        return `${b.textContent.trim().slice(0, 30)} // ${cs.backgroundColor} ${cs.color} radius ${cs.borderRadius} ${cs.fontWeight} ${cs.fontSize}`;
      });
    const lists = [...document.querySelectorAll('ul li')].slice(0, 3).map((li) => {
      const cs = getComputedStyle(li);
      const before = getComputedStyle(li, '::before');
      return `list-style ${cs.listStyleType}; ::before content ${before.content} ${before.width}×${before.height} radius ${before.borderRadius} bg ${before.backgroundColor}`;
    });
    return {
      title: document.title,
      fonts: top(fonts),
      colors: top(colors),
      backgrounds: top(backgrounds),
      vars,
      faces,
      headings,
      brandSvgs,
      images,
      meta,
      buttons,
      lists
    };
  });
  await page.close();
}
fs.writeFileSync('../audit.json', JSON.stringify(audit, null, 1));
await browser.close();
```

Run it with `node capture.mjs`, then read `audit.json` page by page. A full-page screenshot of a
long page is too small to read as one image: crop it into 1440 × 1800 bands (ImageMagick
`-crop`) and read the bands.

## What to download, and from where

- **Fonts:** every `faces` entry's `src` URL. Keep the original file names beside your renamed
  copies, and note each face's weight and whether the site actually uses it (compare with
  `fonts`, the computed usage). A face loaded and never used is noted in the brand's prose and not
  carried as a brand font.
- **Logos:** the inline SVGs in `brandSvgs` (write each to its own file; the header usually has a
  light and a dark variant), plus any `<img>` whose name says logo or mark. Read the fills
  straight from the SVG text: they are the logo's exact colours.
- **Marks at small size:** the favicon and the touch icon from `meta`; the social avatars by hand.
- **The social card:** the `og:image`. It often carries the hero treatment and the tagline.
- **Imagery:** the hero images and two or three photographs that show the photography register;
  any texture file (a hatching, a grain, a pattern) the CSS references.

Convert what the tools cannot open (`.avif`, `.webp`) with `sips` or ImageMagick before reading
it. Keep everything in the scratch folder; only the files the brand needs move into the brand's
`assets/`.

## Reading the audit

- `vars` gives the company's own names for its colours when the site is built on a design system
  or a site builder. Prefer those names in the brand.
- `colors` and `backgrounds` by frequency tell ink from paper from accent. An accent that appears
  a handful of times on a long page is a rule ("one accent element per page"); an accent on every
  heading is another.
- `headings` give the type scale as rendered: size, weight, case, tracking, colour.
- `buttons` and `lists` give the graphic decisions the screens alone would leave to impression:
  radius, fill, the bullet glyph, its size and colour.
- The screens give the rest: dividers, shadows, grid, photography, illustration, how sections
  alternate. Read every band of every page once.

Write the findings as you read, verified and inferred in two columns. The brand's prose carries
that split.
