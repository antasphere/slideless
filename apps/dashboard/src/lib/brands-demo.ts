/**
 * DEMO DATA, NOT A FEATURE. Three invented brands that show what a deck brand
 * could hold in Slideless: nothing here is stored, sent or applied to a deck,
 * and no route, contract or table knows the word. The shape below is the
 * proposal: what one would have to say to make any deck look and sound like
 * one house.
 */
export interface DeckBrand {
  id: string;
  name: string;
  /** Who it is for, in one line. */
  tagline: string;
  /** The voices: a display face for titles and figures, a body face, a label voice for eyebrows. */
  fonts: {
    display: { family: string; weight: number; italic?: boolean; track: string };
    body: { family: string; weight: number };
    label: { family: string; track: string; upper: boolean };
  };
  /** The grounds, the inks, one accent and its counterpart. */
  colors: {
    ground: string;
    surface: string;
    ink: string;
    muted: string;
    hairline: string;
    accent: string;
    accent2: string;
  };
  /** What sits behind a slide. */
  background: { kind: 'field' | 'gradient' | 'flat'; grain: number; label: string };
  /** Corners and lines. */
  shape: { radius: number; stroke: number; label: string };
  motion: { kind: 'still' | 'calm' | 'lively'; label: string };
  /** How it speaks: three words, and a slide written that way. */
  voice: { tone: string[]; eyebrow: string; title: string; body: string };
}

/** One stylesheet for the six faces the three brands use (Google Fonts, already allowed by the CSP). */
export const BRAND_FONTS_HREF =
  'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500&family=Fraunces:opsz,wght@9..144,300;9..144,400&family=Instrument+Serif:ital@0;1&family=Inter:wght@300;400;500&family=JetBrains+Mono:wght@400&family=Space+Grotesk:wght@400;500&display=swap';

export const DEMO_BRANDS: DeckBrand[] = [
  {
    id: 'atelier-nord',
    name: 'Atelier Nord',
    tagline: 'A studio that writes to its clients the way it talks to them.',
    fonts: {
      display: { family: 'Fraunces', weight: 300, track: '-0.015em' },
      body: { family: 'DM Sans', weight: 400 },
      label: { family: 'DM Sans', track: '0.14em', upper: true }
    },
    colors: {
      ground: '#F6EFE4',
      surface: '#FBF7F0',
      ink: '#1E1A16',
      muted: '#75695C',
      hairline: '#E1D6C6',
      accent: '#B8563B',
      accent2: '#2F5D50'
    },
    background: { kind: 'field', grain: 0.5, label: 'Warm field, film grain' },
    shape: { radius: 10, stroke: 1, label: 'Soft corners, hairlines' },
    motion: { kind: 'calm', label: 'Calm: slides rise 14 px' },
    voice: {
      tone: ['Warm', 'Plain-spoken', 'Precise'],
      eyebrow: 'Third quarter',
      title: 'A quiet quarter, on purpose',
      body: 'We shipped less and kept more of it. Here is what stayed.'
    }
  },
  {
    id: 'halcyon',
    name: 'Halcyon',
    tagline: 'An infrastructure company presenting to engineers.',
    fonts: {
      display: { family: 'Space Grotesk', weight: 500, track: '-0.03em' },
      body: { family: 'Inter', weight: 400 },
      label: { family: 'JetBrains Mono', track: '0.04em', upper: false }
    },
    colors: {
      ground: '#0E1116',
      surface: '#161B22',
      ink: '#E8EDF2',
      muted: '#8A96A3',
      hairline: '#27303A',
      accent: '#5EEAD4',
      accent2: '#818CF8'
    },
    background: { kind: 'gradient', grain: 0.2, label: 'Night gradient, light grain' },
    shape: { radius: 4, stroke: 1.5, label: 'Tight corners, firm lines' },
    motion: { kind: 'lively', label: 'Lively: figures count up' },
    voice: {
      tone: ['Direct', 'Technical', 'Confident'],
      eyebrow: '// roadmap.h2',
      title: 'Ship the boring parts first',
      body: 'p99 under 40 ms before any new surface. Three milestones, no slides about vision.'
    }
  },
  {
    id: 'maison-verre',
    name: 'Maison Verre',
    tagline: 'A house of objects, showing a collection to buyers.',
    fonts: {
      display: { family: 'Instrument Serif', weight: 400, italic: true, track: '-0.01em' },
      body: { family: 'Inter', weight: 300 },
      label: { family: 'Inter', track: '0.22em', upper: true }
    },
    colors: {
      ground: '#FBFAF7',
      surface: '#FFFFFF',
      ink: '#111111',
      muted: '#6F6B64',
      hairline: '#E4E1DA',
      accent: '#A8893B',
      accent2: '#111111'
    },
    background: { kind: 'flat', grain: 0, label: 'Flat ivory, no grain' },
    shape: { radius: 0, stroke: 0.75, label: 'Square corners, fine rules' },
    motion: { kind: 'still', label: 'Still: cuts, no transitions' },
    voice: {
      tone: ['Spare', 'Assured', 'Formal'],
      eyebrow: 'Autumn',
      title: 'The collection, in twelve pieces',
      body: 'Blown in small series. Available from October.'
    }
  }
];

/** The brand as the file a deck would carry: what `slideless push --brand` would read. */
export function brandFile(b: DeckBrand): string {
  return JSON.stringify(
    {
      brand: b.id,
      fonts: {
        display: `${b.fonts.display.family} ${b.fonts.display.weight}${b.fonts.display.italic ? ' italic' : ''}`,
        body: `${b.fonts.body.family} ${b.fonts.body.weight}`,
        label: b.fonts.label.family
      },
      colors: {
        ground: b.colors.ground,
        ink: b.colors.ink,
        accent: b.colors.accent,
        accent2: b.colors.accent2
      },
      background: { kind: b.background.kind, grain: b.background.grain },
      shape: { radius: b.shape.radius, stroke: b.shape.stroke },
      motion: b.motion.kind,
      voice: b.voice.tone.map((w) => w.toLowerCase())
    },
    null,
    2
  );
}
