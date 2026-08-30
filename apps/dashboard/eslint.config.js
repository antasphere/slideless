import root from '../../eslint.config.js';

/* The dashboard's lint = the repo's lint, plus one carve-out: the Antasphere
   field engine is copied VERBATIM from the brand console (its header says
   "do not edit here: fix it in the brand console and re-copy"), so it is
   exempted rather than reformatted to local rules. */
export default [{ ignores: ['src/lib/engine/engine.js'] }, ...root];
