import type {
  Audience,
  ManifestEntry,
  MeResponse,
  Presentation,
  Reference,
  ReferenceType
} from '@slideless/contract';
import { t } from '$lib/i18n';

/**
 * The reference sections of the dashboard (PRDCT-2421): what the Brands and
 * Templates pages and their side sheet derive from a deck's mirrored
 * frontmatter, from the person's role and from the browser. Pure functions
 * over the contract's shapes, unit-tested in references.test.ts; the server
 * parses the frontmatter once at push and the dashboard only reads columns.
 *
 * The frontmatter is the AUTHOR'S: the server keeps every field verbatim and
 * opaque, so nothing here trusts a shape. A field that is not what the type
 * expects is rendered as a plain value, never dropped and never thrown on.
 */

/** The five fields every reference carries before the fields of its type. */
export const COMMON_FIELDS = ['type', 'title', 'description', 'tags', 'timestamp'] as const;
/** The structured fields of a brand, in the order the sheet shows them. */
export const BRAND_FIELDS = ['fonts', 'colors', 'background', 'shape', 'motion', 'voice'] as const;
/** The structured fields of a template, in the order the sheet shows them. */
export const TEMPLATE_FIELDS = ['purpose', 'pages', 'fill'] as const;

export function typeFieldsOf(type: ReferenceType): readonly string[] {
  return type === 'brand' ? BRAND_FIELDS : TEMPLATE_FIELDS;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A value as one line a person reads: a string as it is, a number or a
 * boolean spelled out, a list joined by commas, an object as `key: value`
 * pairs. Nested shapes flatten the same way, so nothing the author wrote is
 * lost, only laid flat.
 */
export function plainValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(plainValue).filter(Boolean).join(', ');
  if (isRecord(value)) {
    return Object.entries(value)
      .map(([k, v]) => `${k}: ${plainValue(v)}`)
      .join('; ');
  }
  return '';
}

/** A list of lines: an array item by item, a string as one line, an object as `key: value` lines. */
export function linesOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(plainValue).filter(Boolean);
  if (isRecord(value)) return entriesOf(value).map((e) => `${e.key}: ${e.value}`);
  const one = plainValue(value);
  return one ? [one] : [];
}

export interface KeyValue {
  key: string;
  value: string;
}

/** An object as `key`/`value` rows; a scalar as one row with an empty key; a list as numbered rows. */
export function entriesOf(value: unknown): KeyValue[] {
  if (isRecord(value)) {
    return Object.entries(value)
      .map(([key, v]) => ({ key, value: plainValue(v) }))
      .filter((e) => e.value);
  }
  if (Array.isArray(value)) {
    return value.map((v, i) => ({ key: String(i + 1), value: plainValue(v) })).filter((e) => e.value);
  }
  const one = plainValue(value);
  return one ? [{ key: '', value: one }] : [];
}

/** The frontmatter's description, when the author wrote one. */
export function descriptionOf(reference: Reference | null): string {
  const d = reference?.description;
  return typeof d === 'string' ? d.trim() : '';
}

/** The frontmatter's tags as words. */
export function tagsOf(reference: Reference | null): string[] {
  const tags = reference?.tags;
  if (Array.isArray(tags)) return tags.map(plainValue).filter(Boolean);
  if (typeof tags === 'string')
    return tags
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  return [];
}

// ── Colours ──────────────────────────────────────────────────────────────

export interface Swatch {
  name: string;
  hex: string;
  role: string;
}

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** A CSS hex colour, or null: the swatch's background is an inline style, so only a hex ever reaches it. */
export function hexOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return HEX_RE.test(v) ? v.toUpperCase() : null;
}

/**
 * The brand's colours as swatches, whatever shape the author chose: a list of
 * `{ name, hex, role }`, a list of hex strings, or an object of name to hex.
 * A colour without a usable hex is kept as a name with no swatch.
 */
export function swatchesOf(reference: Reference | null): Swatch[] {
  const colors = reference?.colors;
  const out: Swatch[] = [];
  if (Array.isArray(colors)) {
    for (const c of colors) {
      if (isRecord(c)) {
        const hex = hexOf(c.hex) ?? hexOf(c.value) ?? hexOf(c.color) ?? '';
        const name = plainValue(c.name) || hex;
        if (name || hex) out.push({ name, hex, role: plainValue(c.role) });
      } else {
        const hex = hexOf(c);
        if (hex) out.push({ name: hex, hex, role: '' });
      }
    }
  } else if (isRecord(colors)) {
    for (const [name, v] of Object.entries(colors)) {
      const hex = hexOf(v) ?? (isRecord(v) ? hexOf(v.hex) : null) ?? '';
      out.push({ name, hex, role: isRecord(v) ? plainValue(v.role) : '' });
    }
  }
  return out;
}

// ── Fonts ────────────────────────────────────────────────────────────────

export interface FontFace {
  /** The slot the author gave it: heading, body, mono, display… */
  slot: string;
  family: string;
  weights: number[];
  /** The file inside the bundle, when the author named one. */
  source: string;
}

/**
 * The brand's fonts by slot: `{ heading: { family, weights, source } }`, or
 * `{ heading: 'Fraunces' }`, or a list of the same. A face needs a family to
 * be listed.
 */
export function fontsOf(reference: Reference | null): FontFace[] {
  const fonts = reference?.fonts;
  const out: FontFace[] = [];
  const push = (slot: string, v: unknown) => {
    if (typeof v === 'string') {
      const family = v.trim();
      if (family) out.push({ slot, family, weights: [], source: '' });
      return;
    }
    if (!isRecord(v)) return;
    const family = plainValue(v.family) || plainValue(v.name);
    if (!family) return;
    const weights = Array.isArray(v.weights)
      ? v.weights.map(Number).filter((n) => Number.isFinite(n))
      : typeof v.weight === 'number'
        ? [v.weight]
        : [];
    out.push({ slot, family, weights, source: plainValue(v.source) || plainValue(v.file) });
  };
  if (Array.isArray(fonts)) {
    fonts.forEach((f, i) =>
      push(isRecord(f) ? plainValue(f.slot) || plainValue(f.role) || String(i + 1) : String(i + 1), f)
    );
  } else if (isRecord(fonts)) {
    for (const [slot, v] of Object.entries(fonts)) push(slot, v);
  }
  // The stored object's key order is not the author's (the database keeps
  // JSON keys sorted), so the known slots take their reading order: the
  // display faces, then the body, then the labels and the code face; an
  // unknown slot keeps its place after them.
  return out
    .map((face, i) => ({ face, i, rank: SLOT_RANK.indexOf(face.slot.toLowerCase()) }))
    .sort((a, b) => (a.rank === -1 ? 99 : a.rank) - (b.rank === -1 ? 99 : b.rank) || a.i - b.i)
    .map((x) => x.face);
}

const SLOT_RANK = [
  'display',
  'heading',
  'headings',
  'title',
  'titles',
  'body',
  'text',
  'label',
  'labels',
  'mono',
  'code'
];

/**
 * The Google Fonts families the sheet may load a specimen for. The content
 * security policy allows the two Google Fonts hosts and nothing else, and a
 * family the service does not serve would render in a fallback face that
 * passes for the brand's: so only a family on this list gets a specimen, and
 * every other one is shown as a plain name. Matched without case.
 */
export const GOOGLE_FONTS = [
  'Archivo',
  'Bricolage Grotesque',
  'Cormorant',
  'Cormorant Garamond',
  'Crimson Pro',
  'DM Mono',
  'DM Sans',
  'DM Serif Display',
  'EB Garamond',
  'Figtree',
  'Fira Code',
  'Fira Sans',
  'Fraunces',
  'Geist',
  'IBM Plex Mono',
  'IBM Plex Sans',
  'IBM Plex Serif',
  'Inconsolata',
  'Instrument Sans',
  'Instrument Serif',
  'Inter',
  'JetBrains Mono',
  'Karla',
  'Lato',
  'Libre Baskerville',
  'Libre Franklin',
  'Lora',
  'Manrope',
  'Merriweather',
  'Montserrat',
  'Newsreader',
  'Noto Sans',
  'Noto Serif',
  'Nunito',
  'Nunito Sans',
  'Open Sans',
  'Oswald',
  'Outfit',
  'Playfair Display',
  'Plus Jakarta Sans',
  'Poppins',
  'PT Sans',
  'PT Serif',
  'Raleway',
  'Roboto',
  'Roboto Mono',
  'Roboto Slab',
  'Rubik',
  'Sora',
  'Source Code Pro',
  'Source Sans 3',
  'Source Serif 4',
  'Space Grotesk',
  'Space Mono',
  'Spectral',
  'Work Sans'
] as const;

const GOOGLE_FONTS_LOWER = new Map(GOOGLE_FONTS.map((f) => [f.toLowerCase(), f] as const));

/** The family as Google Fonts spells it when it serves it, else null. */
export function googleFontOf(family: string): string | null {
  return GOOGLE_FONTS_LOWER.get(family.trim().toLowerCase()) ?? null;
}

/**
 * One stylesheet URL for the specimens of the faces Google Fonts serves, or
 * null when none is. Regular weight only: a specimen is two letters.
 */
export function googleFontsHref(faces: Pick<FontFace, 'family'>[]): string | null {
  const families = [...new Set(faces.map((f) => googleFontOf(f.family)).filter((f): f is string => !!f))];
  if (!families.length) return null;
  const query = families.map((f) => `family=${encodeURIComponent(f).replace(/%20/g, '+')}`).join('&');
  return `https://fonts.googleapis.com/css2?${query}&display=swap`;
}

// ── The voice, the extra keys ────────────────────────────────────────────

export interface Voice {
  tone: string[];
  avoid: string[];
  /** The rest of the voice fields, `example` and `person` included, as rows. */
  rest: KeyValue[];
}

/** The brand's voice: its tones and its words to avoid as chips, the rest as rows. */
export function voiceOf(reference: Reference | null): Voice | null {
  const voice = reference?.voice;
  if (voice === undefined || voice === null) return null;
  if (!isRecord(voice)) {
    const one = plainValue(voice);
    return one ? { tone: [one], avoid: [], rest: [] } : null;
  }
  const words = (v: unknown) =>
    Array.isArray(v)
      ? v.map(plainValue).filter(Boolean)
      : typeof v === 'string'
        ? v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
  const rest = Object.entries(voice)
    .filter(([k]) => k !== 'tone' && k !== 'avoid')
    .map(([key, v]) => ({ key, value: plainValue(v) }))
    .filter((e) => e.value);
  return { tone: words(voice.tone), avoid: words(voice.avoid), rest };
}

/** Every frontmatter key the type does not define, kept as rows: nothing the author wrote is dropped. */
export function extraFieldsOf(
  reference: Reference | null,
  type: ReferenceType,
  /** Typed fields the section could not read in their own shape: shown here as plain rows rather than dropped. */
  unread: readonly string[] = []
): KeyValue[] {
  if (!reference) return [];
  const known = new Set<string>([...COMMON_FIELDS, ...typeFieldsOf(type)]);
  const kept = new Set(unread);
  return Object.entries(reference)
    .filter(([k]) => !known.has(k) || kept.has(k))
    .map(([key, v]) => ({ key, value: plainValue(v) }))
    .filter((e) => e.value);
}

// ── Who may do what (the page hides; the server rules) ──────────────────

/** Whoever administers the deck sets its audience: its owner, a workspace admin or owner. */
export function canSetAudience(
  me: Pick<MeResponse, 'role' | 'user'>,
  deck: Pick<Presentation, 'ownerUserId'>
): boolean {
  return me.role === 'owner' || me.role === 'admin' || deck.ownerUserId === me.user.id;
}

/** The workspace's default is a workspace decision: admin or owner only. */
export function canSetDefault(me: Pick<MeResponse, 'role'>): boolean {
  return me.role === 'owner' || me.role === 'admin';
}

/** One sentence saying who reads the reference under an audience. */
export function audienceSentence(audience: Audience): string {
  return audience === 'workspace' ? t('refs.readsWorkspace') : t('refs.readsPrivate');
}

/** The sentence for a refusal the server answers on the audience or the default, in words. */
export function referenceRefusal(code: string | undefined, type: ReferenceType): string | null {
  const typeName = t(type === 'brand' ? 'refs.typeBrandLower' : 'refs.typeTemplateLower');
  if (code === 'default_reference') return t('refs.refuseDefaultPrivate', { type: typeName });
  if (code === 'audience_private') return t('refs.refuseAudiencePrivate', { type: typeName });
  return null;
}

// ── The cards-or-table choice, kept per section ─────────────────────────

export type ReferenceView = 'cards' | 'table';

export function viewKeyOf(type: ReferenceType): string {
  return `slideless.${type}s.view`;
}

/** The view the browser remembers for a section; cards when nothing is remembered or storage is off. */
export function readView(
  type: ReferenceType,
  storage: Pick<Storage, 'getItem'> | null = storageOrNull()
): ReferenceView {
  try {
    return storage?.getItem(viewKeyOf(type)) === 'table' ? 'table' : 'cards';
  } catch {
    return 'cards';
  }
}

/** Remember the view; a browser that refuses storage keeps the choice for the visit only. */
export function writeView(
  type: ReferenceType,
  view: ReferenceView,
  storage: Pick<Storage, 'setItem'> | null = storageOrNull()
): void {
  try {
    storage?.setItem(viewKeyOf(type), view);
  } catch {
    /* not persisted, still applied */
  }
}

function storageOrNull(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

// ── The files of a version ──────────────────────────────────────────────

export interface FileGroup {
  /** `assets` for the `assets/` folder, `root` for everything else. */
  id: 'assets' | 'root';
  files: ManifestEntry[];
}

/** The basename a file is saved under: the last segment of its manifest path. */
export function basenameOf(path: string): string {
  return path.split('/').pop() || path;
}

/**
 * A version's manifest as the sheet lists it: the `assets/` folder first
 * (the logo, the fonts, what a deck reuses), then everything else, each
 * group sorted by path. An empty group is left out.
 */
export function fileGroupsOf(manifest: ManifestEntry[]): FileGroup[] {
  const byPath = (a: ManifestEntry, b: ManifestEntry) => a.path.localeCompare(b.path);
  const assets = manifest.filter((f) => f.path.startsWith('assets/')).sort(byPath);
  const root = manifest.filter((f) => !f.path.startsWith('assets/')).sort(byPath);
  const out: FileGroup[] = [];
  if (assets.length) out.push({ id: 'assets', files: assets });
  if (root.length) out.push({ id: 'root', files: root });
  return out;
}

/** The section's search, on the title and the frontmatter's description. */
export function matchesQuery(deck: Pick<Presentation, 'title' | 'reference'>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return deck.title.toLowerCase().includes(q) || descriptionOf(deck.reference).toLowerCase().includes(q);
}
