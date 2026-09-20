import {
  defineChassisContract,
  type ApiKeyCreatedOf,
  type ApiKeyCreateOf,
  type ApiKeyInfoOf,
  type CliAuthCompletedOf,
  type MeResponseOf,
  type ScopeOf
} from '@antasphere/chassis-contract';

import { IDENTITY } from './identity.js';

/**
 * The ONE instantiation of the chassis contract for Slideless. The scope
 * vocabulary is the tool's identity, so it is spelled in `./identity.ts` and
 * nowhere in `@antasphere/chassis-contract`; every schema that carries it (the
 * scope enum, the API-key family, the CLI key mint answer, `/me`) is built
 * from it and exported under the name it has always had.
 */
const { read, write, dataExport } = IDENTITY.scopes;
export const chassisContract = defineChassisContract({ scopes: [read, write, dataExport] });

/**
 * Generic scopes; products define their own (e.g. products:read).
 * `data:export` is a deliberate opt-in for the full-workspace export — it
 * never rides `presentations:read`, or any admin read key would be a whole-tenant
 * exfiltration tool.
 */
export const scopeSchema = chassisContract.scopeSchema;
export type Scope = ScopeOf<typeof chassisContract>;

export const apiKeySchema = chassisContract.apiKeySchema;
export type ApiKeyInfo = ApiKeyInfoOf<typeof chassisContract>;
export const apiKeysListSchema = chassisContract.apiKeysListSchema;
export const apiKeyCreateSchema = chassisContract.apiKeyCreateSchema;
export type ApiKeyCreate = ApiKeyCreateOf<typeof chassisContract>;
export const apiKeyCreatedSchema = chassisContract.apiKeyCreatedSchema;
export type ApiKeyCreated = ApiKeyCreatedOf<typeof chassisContract>;

export const cliAuthCompletedSchema = chassisContract.cliAuthCompletedSchema;
export type CliAuthCompleted = CliAuthCompletedOf<typeof chassisContract>;

export const meResponseSchema = chassisContract.meResponseSchema;
export type MeResponse = MeResponseOf<typeof chassisContract>;
