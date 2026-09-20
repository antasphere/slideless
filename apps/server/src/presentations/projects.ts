import { sql, type SQL } from 'drizzle-orm';
import type { Principal } from '@antasphere/chassis-contract';
import type { DbConn } from '@antasphere/chassis-db';
import { projectGrantPredicate } from '@antasphere/chassis-server/projects';

/**
 * The PROJECT branch of the deck access rules (ADR 026, amending ADR 013).
 *
 * A deck linked to a project (`presentation_projects`) is READ by every
 * member of that project, whatever their role, and WRITTEN by its editors and
 * managers while the project is not archived. `canAdministerDeck` does not
 * know projects: deleting a deck and managing its collaborators stay the
 * owner's and the workspace admins'.
 *
 * Both predicates are the chassis' own question (`projectGrantPredicate`)
 * asked over this tool's link table, so the guest refusal, the live
 * membership, the role ladder and the archived-write rule are the chassis'
 * and cannot drift here. `deckId` is a SQL reference to a presentation id IN
 * THE CALLER'S QUERY, always qualified (`p.id`, `"presentations"."id"`) or a
 * bound value: see the select-list trap documented on the chassis builder.
 *
 * The READ predicate has THREE homes, and they change together:
 * `canReadDeck`, the list's WHERE, and `blobReadScope` (service.ts). Each is
 * pinned on its own by `deck-projects.test.ts`.
 */
type AccessPrincipal = Pick<Principal, 'userId' | 'workspaceId' | 'role' | 'origin'>;

export function deckProjectReadPredicate(principal: AccessPrincipal, deckId: SQL): SQL {
  return sql`EXISTS (
    SELECT 1 FROM presentation_projects dpp_r
    WHERE dpp_r.presentation_id = ${deckId}
      AND ${projectGrantPredicate(principal, sql`dpp_r.project_id`, { atLeast: 'viewer', access: 'read' })}
  )`;
}

export function deckProjectWritePredicate(principal: AccessPrincipal, deckId: SQL): SQL {
  return sql`EXISTS (
    SELECT 1 FROM presentation_projects dpp_w
    WHERE dpp_w.presentation_id = ${deckId}
      AND ${projectGrantPredicate(principal, sql`dpp_w.project_id`, { atLeast: 'editor', access: 'write' })}
  )`;
}

/** `presentations.id`, always qualified: safe wherever drizzle would drop the table name. */
export const PRESENTATIONS_ID: SQL = sql.raw('"presentations"."id"');

/**
 * True when the principal may LINK a resource of their own to this project:
 * editor or more, project not archived (the chassis' archived-write rule).
 */
export function canLinkIntoProject(
  conn: DbConn,
  principal: AccessPrincipal,
  projectId: string
): Promise<boolean> {
  return holds(
    conn,
    projectGrantPredicate(principal, sql`${projectId}::uuid`, { atLeast: 'editor', access: 'write' })
  );
}

async function holds(conn: DbConn, predicate: SQL): Promise<boolean> {
  const { rows } = await conn.execute(sql`SELECT ${predicate} AS ok`);
  return (rows[0] as { ok: boolean } | undefined)?.ok === true;
}

/** True when the principal READS this deck through a project it is linked to. */
export function readsDeckThroughProject(
  conn: DbConn,
  principal: AccessPrincipal,
  deckId: string
): Promise<boolean> {
  if (principal.origin === 'guest') return Promise.resolve(false);
  return holds(conn, deckProjectReadPredicate(principal, sql`${deckId}::uuid`));
}

/** True when the principal WRITES this deck through a live project it is an editor or manager of. */
export function writesDeckThroughProject(
  conn: DbConn,
  principal: AccessPrincipal,
  deckId: string
): Promise<boolean> {
  if (principal.origin === 'guest') return Promise.resolve(false);
  return holds(conn, deckProjectWritePredicate(principal, sql`${deckId}::uuid`));
}
