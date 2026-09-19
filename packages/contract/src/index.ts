// Client-safe entry: pure zod schemas + seam types. No Hono anywhere on this
// path — the dashboard and SDK import from here and must stay server-free.
// The generic half lives in @antasphere/chassis-contract and is imported from
// there by its consumers — never re-exported here. What IS exported here from
// the chassis is its one instantiation with the Slideless scopes (./chassis.ts).
export {
  scopeSchema,
  apiKeySchema,
  apiKeysListSchema,
  apiKeyCreateSchema,
  apiKeyCreatedSchema,
  cliAuthCompletedSchema,
  meResponseSchema,
  type Scope,
  type ApiKeyInfo,
  type ApiKeyCreate,
  type ApiKeyCreated,
  type CliAuthCompleted,
  type MeResponse
} from './chassis.js';
export * from './schemas/presentations.js';
export * from './schemas/share-tokens.js';
export * from './schemas/collaborators.js';
export * from './schemas/annotations.js';
export * from './schemas/forms.js';
export * from './embed.js';
// Lane B (PRDCT-2280): the deck's master page path, built in one place.
export * from './master-route.js';
// Lane F (PRDCT-2308): the one motion, written once and mirrored by tests.
export * from './motion.js';
