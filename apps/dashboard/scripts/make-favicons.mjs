// Regenerates the dashboard's raster icons from static/favicon.svg (PRDCT-2401).
//
// static/favicon.svg is the Antasphere tile, BYTE-IDENTICAL to
// company/brand's public/favicon.svg (itself generated from the brand's
// mark-light.svg). Never edit it here: replace it with the brand's file and
// run `node scripts/make-favicons.mjs` from apps/dashboard. The PNGs are drawn
// by the Playwright Chromium this package already carries, the same way the
// brand console rasterises its own downloads, so no image toolchain is needed.
//
//   favicon.ico            16 + 32, PNG-in-ICO
//   apple-touch-icon.png   180, full-bleed square: iOS applies its own mask and
//                          paints transparent corners black
//   icon-192.png, icon-512.png   the web manifest's icons, the rounded tile
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const staticDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'static');
const svg = await readFile(join(staticDir, 'favicon.svg'), 'utf8');
if (!svg.includes('rx="14"'))
  throw new Error('favicon.svg: the tile radius moved; update the full-bleed swap');
const fullBleed = svg.replace('rx="14"', 'rx="0"');

const browser = await chromium.launch();
async function png(source, size) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  const sized = source.replace('width="64" height="64"', `width="${size}" height="${size}"`);
  await page.setContent(
    `<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block}</style>${sized}`
  );
  const bytes = await page.screenshot({
    omitBackground: true,
    clip: { x: 0, y: 0, width: size, height: size }
  });
  await page.close();
  return bytes;
}

const [p16, p32, p180, p192, p512] = [
  await png(svg, 16),
  await png(svg, 32),
  await png(fullBleed, 180),
  await png(svg, 192),
  await png(svg, 512)
];
await browser.close();

// ICO container around PNG payloads: ICONDIR, one ICONDIRENTRY per image, then the bytes.
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, bytes }, i) => {
    const at = 6 + 16 * i;
    header.writeUInt8(size, at);
    header.writeUInt8(size, at + 1);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(bytes.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += bytes.length;
  });
  return Buffer.concat([header, ...images.map((i) => i.bytes)]);
}

await writeFile(
  join(staticDir, 'favicon.ico'),
  ico([
    { size: 16, bytes: p16 },
    { size: 32, bytes: p32 }
  ])
);
await writeFile(join(staticDir, 'apple-touch-icon.png'), p180);
await writeFile(join(staticDir, 'icon-192.png'), p192);
await writeFile(join(staticDir, 'icon-512.png'), p512);
console.log('wrote favicon.ico, apple-touch-icon.png, icon-192.png, icon-512.png');
