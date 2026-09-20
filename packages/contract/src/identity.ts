import type { ToolIdentity } from '@antasphere/chassis-contract';

/**
 * The identity of this tool: every value that names it where a person, an
 * agent or an operator can see it, written ONCE. The contract, the server and
 * the CLI read it from here (the SDK and the dashboard can: they already depend
 * on this package); the chassis packages spell none of it. A new tool rewrites
 * this file to take its own name.
 *
 * What cannot read a value at run time (package names, the `bin` key of the
 * CLI's package.json, the image reference in the Dockerfile and the workflows,
 * the Postgres role) must be kept in step by hand, or by the instantiate script.
 */
export const IDENTITY = {
  slug: 'slideless',
  displayName: 'Slideless',
  apiKeyPrefix: 'slk',
  scopes: {
    read: 'presentations:read',
    write: 'presentations:write',
    dataExport: 'data:export'
  },
  cliKeyScopesLabel: 'presentations:read+write',
  cli: {
    bin: 'slideless',
    envPrefix: 'SLIDELESS',
    legacyConfigDir: 'slideless'
  },
  mcp: {
    serverName: 'slideless',
    toolPrefix: 'slideless_'
  },
  otelServiceName: 'slideless',
  imageName: 'ghcr.io/antasphere/slideless'
} as const satisfies ToolIdentity;
