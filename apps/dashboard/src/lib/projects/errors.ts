/**
 * What an answer of the projects API refused, read off the thrown error
 * (PRDCT-2582). The pages go through the `projects` client alone, whose errors
 * carry a `status` and a `code` whichever body it has (the stub today, the SDK
 * after the rebase), so they are read by shape and never by class.
 */
export function errorStatus(e: unknown): number | null {
  const status = (e as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : null;
}

export function errorCode(e: unknown): string | null {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

/** A project nobody may read here answers 404, to a stranger and to a non-member alike. */
export const isNotFound = (e: unknown) => errorStatus(e) === 404;
