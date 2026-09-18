/**
 * DEMO DATA, NOT A FEATURE. Four invented brands that show what a deck brand
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
  /**
   * A brand IS a deck: its pages say the brand to a person (and to an agent
   * reading them), and the files attached to it are what a deck needs to wear
   * it. Pushed, versioned and shared like any other deck.
   */
  deck: {
    pages: number;
    versions: number;
    files: string[];
    usedBy: number;
    /** Days since its last version was pushed (made up, like the rest). */
    updatedDaysAgo: number;
  };
}

/** One stylesheet for the six faces the four brands share (Google Fonts, already allowed by the CSP). */
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
    },
    deck: {
      pages: 9,
      versions: 4,
      files: ['logo.svg', 'Fraunces.woff2', 'DMSans.woff2', 'voice.md'],
      usedBy: 3,
      updatedDaysAgo: 2
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
    },
    deck: {
      pages: 12,
      versions: 7,
      files: ['mark.svg', 'SpaceGrotesk.woff2', 'charts.css', 'voice.md'],
      usedBy: 1,
      updatedDaysAgo: 9
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
    },
    deck: {
      pages: 7,
      versions: 2,
      files: ['monogram.svg', 'InstrumentSerif.woff2', 'lookbook.pdf'],
      usedBy: 1,
      updatedDaysAgo: 31
    }
  },
  {
    id: 'tandem',
    name: 'Tandem',
    tagline: 'A cycling cooperative, reporting to the members who own it.',
    fonts: {
      display: { family: 'DM Sans', weight: 500, track: '-0.035em' },
      body: { family: 'Inter', weight: 400 },
      label: { family: 'JetBrains Mono', track: '0.08em', upper: true }
    },
    colors: {
      ground: '#FFF8E7',
      surface: '#FFFDF6',
      ink: '#1B1F3B',
      muted: '#686C86',
      hairline: '#E9E0C8',
      accent: '#2F4BDB',
      accent2: '#F2B233'
    },
    background: { kind: 'flat', grain: 0.15, label: 'Flat cream, a trace of grain' },
    shape: { radius: 16, stroke: 2, label: 'Round corners, bold lines' },
    motion: { kind: 'lively', label: 'Lively: bars grow from the floor' },
    voice: {
      tone: ['Friendly', 'Numerate', 'Brisk'],
      eyebrow: 'Members meeting',
      title: 'More riders, fewer flat tyres',
      body: '412 members, 38 repair evenings, one new workshop. The year in six figures.'
    },
    deck: {
      pages: 10,
      versions: 3,
      files: ['wheel.svg', 'DMSans.woff2', 'charts.css', 'voice.md'],
      usedBy: 2,
      updatedDaysAgo: 5
    }
  }
];

/** The pages a brand deck carries, in the order a person reads a house style. */
export const BRAND_DECK_PAGES = ['Cover', 'Colours', 'Type', 'Voice', 'Layouts'] as const;
