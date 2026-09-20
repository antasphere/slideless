import { z } from 'zod';
import { INT4_MAX } from '@antasphere/chassis-contract';

/**
 * A deck version number in a JSON body: a positive int4. The upper bound is
 * part of the contract (FUZZ-9's generalization): `version` lands in a
 * Postgres `integer` column, and 1e15 passes `.int()` but overflows int4 into
 * a driver error → 500.
 */
export const versionNumberSchema = z.number().int().min(1).max(INT4_MAX);

/**
 * A deck version number arriving as a STRING (path segment or query param):
 * strictly digits, then int4-bounded (FUZZ-9). `z.coerce.number()` alone
 * accepted `1e5`, `0x10`, ` 1 `, and `99999999999999999999` — the last one is
 * `Number.isInteger`-true and overflowed Postgres int4 into a 500.
 */
export const versionParamSchema = z
  .string()
  .regex(/^\d{1,10}$/, 'version must be a positive integer')
  .transform(Number)
  .pipe(versionNumberSchema);
