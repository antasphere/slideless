import pkg from '../package.json' with { type: 'json' };

/**
 * The app's own version, baked into the bundle at build time (tsup inlines
 * the JSON import), so every image reports its true semver with no CI
 * involvement. The canonical version is the ROOT package.json; this package's
 * copy is the carrier the bundle can reach (the root file is outside the
 * deployed package), and env.test.ts pins the two against drift. Bump both
 * together on a release; the release workflow refuses a v-tag that disagrees.
 */
export const INTRINSIC_VERSION: string = pkg.version;
