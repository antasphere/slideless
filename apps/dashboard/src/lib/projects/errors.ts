/**
 * What an answer of the projects API refused, read off the thrown error
 * (PRDCT-2582): the SDK's `PlatformApiError` carries a `status` and a `code`.
 * Read by shape, so a page never imports the SDK's class for one field.
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
