import { createHash } from 'node:crypto';

/**
 * Taking bytes from an instance, safely: the two checks every download that
 * lands on a developer's disk goes through BEFORE `safe-write.ts` is asked
 * to write anything (PRDCT-1353). `pull` (deck assets, declared by the
 * manifest) and `response-files` (respondent uploads, declared by the
 * response's `files`) share them.
 */

/**
 * Read a response body with a hard ceiling, streaming: the wire DECLARES
 * each blob's size, so anything bigger is a lie and must not be buffered
 * (an unbounded `arrayBuffer()` on a hostile instance is a memory bomb).
 * `declaredBy` names who declared the size, for the refusal's wording.
 */
export async function readCapped(
  res: Response,
  maxBytes: number,
  label: string,
  declaredBy = "the manifest's"
): Promise<Buffer> {
  const tooBig = (): Error =>
    new Error(`Refusing ${label}: the download exceeds ${declaredBy} declared ${maxBytes} bytes.`);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooBig();
  const body = res.body;
  if (!body) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw tooBig();
    return buf;
  }
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooBig();
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** The lowercase hex sha256 of `bytes`. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
