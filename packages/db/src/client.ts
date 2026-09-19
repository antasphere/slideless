import * as chassisSchema from '@antasphere/chassis-db/schema';
import { createDb as createChassisDb, type DbHandle } from '@antasphere/chassis-db';
import * as deckSchema from './schema.js';

/**
 * The one place the chassis tables and the deck tables are merged: the full
 * schema object drizzle is constructed with. It is NOT re-exported — a chassis
 * table is imported from `@antasphere/chassis-db`, a deck table from here.
 */
const schema = { ...chassisSchema, ...deckSchema };

export function createDb(connectionString: string): DbHandle {
  return createChassisDb(connectionString, schema);
}
