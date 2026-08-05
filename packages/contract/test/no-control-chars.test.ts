import { describe, expect, it } from 'vitest';
import { hasControlChars, plainText } from '../src/schemas/common.js';
import { apiKeyCreateSchema } from '../src/schemas/api-keys.js';
import { setupRequestSchema } from '../src/schemas/setup.js';
import { invitationAcceptSchema } from '../src/schemas/invitations.js';
import { cliAuthCompleteSchema } from '../src/schemas/cli-auth.js';
import { fileUploadQuerySchema } from '../src/schemas/files.js';
import { annotationCreateSchema, annotationUpdateSchema } from '../src/schemas/annotations.js';
import { presentationUpdateSchema, uploadSessionCommitSchema } from '../src/schemas/presentations.js';
import { shareTokenCreateSchema } from '../src/schemas/share-tokens.js';
import { collaboratorClaimSchema } from '../src/schemas/collaborators.js';

/**
 * SL-B4: Postgres cannot store a NUL in a text value — it raises SQLSTATE
 * 22021 from inside the driver, which surfaced as an anonymous 500 whose
 * error-level log line printed the failing SQL and its bound parameters.
 * Every free-text sink now refuses it at the contract, so the caller gets the
 * ordinary 400 validation_error and nothing reaches the database.
 */
const NUL = '\u0000';

describe('hasControlChars', () => {
  it('flags NUL and the invisible C0 controls', () => {
    expect(hasControlChars(`acme${NUL}`)).toBe(true);
    expect(hasControlChars('acme\u0007')).toBe(true);
    expect(hasControlChars('acme\u001b[31m')).toBe(true);
    expect(hasControlChars('acme\u007f')).toBe(true);
  });

  it('allows ordinary text, including multi-line', () => {
    expect(hasControlChars('Acme Corp — 2026')).toBe(false);
    expect(hasControlChars('line one\nline two\ttabbed\r\n')).toBe(false);
    expect(hasControlChars('日本語 🎉')).toBe(false);
  });
});

describe('plainText', () => {
  it('keeps the length bounds and adds the control-character refusal', () => {
    const schema = plainText(1, 5);
    expect(schema.safeParse('ok').success).toBe(true);
    expect(schema.safeParse('').success).toBe(false);
    expect(schema.safeParse('toolong').success).toBe(false);
    expect(schema.safeParse(`ok${NUL}`).success).toBe(false);
  });
});

describe('every free-text sink refuses a NUL byte', () => {
  it('API key name', () => {
    expect(apiKeyCreateSchema.safeParse({ name: `ci${NUL}`, scopes: ['presentations:read'] }).success).toBe(
      false
    );
    expect(apiKeyCreateSchema.safeParse({ name: 'ci', scopes: ['presentations:read'] }).success).toBe(true);
  });

  it('setup instance name and owner name', () => {
    const valid = {
      instanceName: 'Acme',
      owner: { email: 'a@b.io', name: 'Ann', password: 'correct horse battery' }
    };
    expect(setupRequestSchema.safeParse(valid).success).toBe(true);
    expect(setupRequestSchema.safeParse({ ...valid, instanceName: `Acme${NUL}` }).success).toBe(false);
    expect(
      setupRequestSchema.safeParse({ ...valid, owner: { ...valid.owner, name: `Ann${NUL}` } }).success
    ).toBe(false);
  });

  it('invitation accept name', () => {
    const valid = { token: 'x'.repeat(20), name: 'Ann', password: 'correct horse battery' };
    expect(invitationAcceptSchema.safeParse(valid).success).toBe(true);
    expect(invitationAcceptSchema.safeParse({ ...valid, name: `Ann${NUL}` }).success).toBe(false);
  });

  it('CLI key name', () => {
    const valid = { email: 'a@b.io', otp: '123456', keyName: 'laptop' };
    expect(cliAuthCompleteSchema.safeParse(valid).success).toBe(true);
    expect(cliAuthCompleteSchema.safeParse({ ...valid, keyName: `laptop${NUL}` }).success).toBe(false);
  });

  it('file upload name', () => {
    expect(fileUploadQuerySchema.safeParse({ name: 'report.pdf' }).success).toBe(true);
    expect(fileUploadQuerySchema.safeParse({ name: `report${NUL}.pdf` }).success).toBe(false);
  });

  /**
   * The reachable-by-a-stranger sink on THIS repo: a share-token reviewer can
   * annotate without an account, so the annotation body is the free text an
   * anonymous client can most easily drive into a Postgres text column.
   */
  it('annotation body (reviewer-reachable, no account needed)', () => {
    const selection = { page: 'index.html', anchor: { kind: 'sheet' } };
    const valid = { version: 1, selection, body: 'Looks good on slide 3' };
    expect(annotationCreateSchema.safeParse(valid).success).toBe(true);
    expect(annotationCreateSchema.safeParse({ ...valid, body: `note${NUL}` }).success).toBe(false);
    // Multi-line review notes stay legal — plainText allows tab/LF/CR.
    expect(annotationCreateSchema.safeParse({ ...valid, body: 'line one\nline two' }).success).toBe(true);
    expect(annotationUpdateSchema.safeParse({ body: `note${NUL}` }).success).toBe(false);
  });

  it('deck title, on both the commit and the rename path', () => {
    expect(presentationUpdateSchema.safeParse({ title: 'Q3 deck' }).success).toBe(true);
    expect(presentationUpdateSchema.safeParse({ title: `Q3${NUL}` }).success).toBe(false);

    // The commit schema needs a VALID surrounding payload, and the failure has
    // to be attributed to `title` specifically. Asserting only `success ===
    // false` on a half-built object passes for any reason at all — which is
    // how this case slipped through its own mutation check the first time.
    const commit = {
      title: 'Q3 deck',
      entryPath: 'index.html',
      manifest: [{ path: 'index.html', sha256: 'a'.repeat(64), sizeBytes: 1, contentType: 'text/html' }]
    };
    expect(uploadSessionCommitSchema.safeParse(commit).success).toBe(true);
    const withNul = uploadSessionCommitSchema.safeParse({ ...commit, title: `Q3${NUL}` });
    expect(withNul.success).toBe(false);
    expect(withNul.error?.issues.map((i) => i.path.join('.'))).toEqual(['title']);
  });

  it('share-token name', () => {
    expect(shareTokenCreateSchema.safeParse({ name: 'Client review' }).success).toBe(true);
    expect(shareTokenCreateSchema.safeParse({ name: `Client${NUL}` }).success).toBe(false);
  });

  it('collaborator claim name', () => {
    const valid = { token: 'x'.repeat(20), name: 'Ann', password: 'correct horse battery' };
    expect(collaboratorClaimSchema.safeParse(valid).success).toBe(true);
    expect(collaboratorClaimSchema.safeParse({ ...valid, name: `Ann${NUL}` }).success).toBe(false);
  });
});
