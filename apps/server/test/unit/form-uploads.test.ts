import { describe, expect, it } from 'vitest';
import {
  formUploadCaps,
  responseZipFolder,
  sanitizeUploadName,
  uniqueZipPath,
  zipSegment
} from '../../src/forms/uploads.js';
import { isViewerFormUploadPath } from '../../src/viewer/forms-api.js';

/**
 * PRDCT-2403 — the pure halves of the form file uploads: what a respondent's
 * text may become on the owner's disk, and which ONE path rides the body-cap
 * exemption. The behaviour against the booted app is
 * test/integration/form-uploads.test.ts.
 */

describe('sanitizeUploadName', () => {
  it('keeps a basename, whatever separators and dots came with it', () => {
    expect(sanitizeUploadName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeUploadName('C:\\Users\\me\\report.pdf')).toBe('report.pdf');
    expect(sanitizeUploadName('...hidden')).toBe('hidden');
    expect(sanitizeUploadName('  spaced.pdf  ')).toBe('spaced.pdf');
  });

  it('drops control, bidi-override and line-separator characters', () => {
    expect(sanitizeUploadName('a\u0000b\u001fc\u007f.pdf')).toBe('abc.pdf');
    expect(sanitizeUploadName('invoice\u202efdp.exe')).toBe('invoicefdp.exe');
    expect(sanitizeUploadName('x\u2028y\u2066z')).toBe('xyz');
  });

  it('never answers an empty name, and caps the length while keeping the extension', () => {
    expect(sanitizeUploadName('')).toBe('file');
    expect(sanitizeUploadName('/')).toBe('file');
    expect(sanitizeUploadName('..')).toBe('file');
    const long = sanitizeUploadName('n'.repeat(600) + '.docx');
    expect(long).toHaveLength(255);
    expect(long.endsWith('.docx')).toBe(true);
  });
});

describe('zip entry paths built from respondent text', () => {
  it('a segment can never steer where an entry lands', () => {
    expect(zipSegment('..')).toBe('_');
    expect(zipSegment('.')).toBe('_');
    expect(zipSegment('')).toBe('_');
    expect(zipSegment('a/b\\c')).toBe('a_b_c');
    expect(zipSegment('.ssh')).toBe('_ssh');
    expect(zipSegment('trailing. . ')).toBe('trailing');
    expect(zipSegment('co\u0000n:tr|ol?')).toBe('con_tr_ol_');
    expect(zipSegment('x'.repeat(500))).toHaveLength(200);
  });

  it('two files of one name get distinct paths, case-insensitively', () => {
    const taken = new Set<string>();
    expect(uniqueZipPath('docs/', 'scan.pdf', taken)).toBe('docs/scan.pdf');
    expect(uniqueZipPath('docs/', 'scan.pdf', taken)).toBe('docs/scan (2).pdf');
    expect(uniqueZipPath('docs/', 'SCAN.PDF', taken)).toBe('docs/SCAN (3).PDF');
    expect(uniqueZipPath('docs/', 'noext', taken)).toBe('docs/noext');
    expect(uniqueZipPath('docs/', 'noext', taken)).toBe('docs/noext (2)');
    expect(uniqueZipPath('other/', 'scan.pdf', taken)).toBe('other/scan.pdf');
  });

  it("a response's folder is its first-sent minute and the head of its id", () => {
    expect(responseZipFolder('0f3c9a2e-1111-4222-8333-444455556666', new Date('2026-09-18T12:34:56Z'))).toBe(
      '20260918-1234-0f3c9a2e'
    );
  });
});

describe('the instance ceilings', () => {
  const base = {
    MAX_FILE_SIZE_MB: 100,
    FORMS_MAX_FILES_PER_RESPONSE: 100,
    FORMS_MAX_UPLOADS_MB_PER_DECK: 5120
  };
  it('the form ceiling never exceeds the per-file cap of the instance, and 0 switches uploads off', () => {
    expect(formUploadCaps({ ...base, FORMS_MAX_UPLOAD_MB: 100 }).maxFileBytes).toBe(100 * 1024 * 1024);
    expect(formUploadCaps({ ...base, FORMS_MAX_UPLOAD_MB: 500 }).maxFileBytes).toBe(100 * 1024 * 1024);
    expect(formUploadCaps({ ...base, FORMS_MAX_UPLOAD_MB: 10 }).maxFileBytes).toBe(10 * 1024 * 1024);
    expect(formUploadCaps({ ...base, FORMS_MAX_UPLOAD_MB: 0 }).maxFileBytes).toBe(0);
  });
});

describe('the body-cap exemption', () => {
  it('matches the upload route and nothing else', () => {
    expect(isViewerFormUploadPath('/api/v1/viewer/SECRET/forms/kyc/uploads')).toBe(true);
    for (const path of [
      '/api/v1/viewer/SECRET/forms/kyc/uploads/',
      '/api/v1/viewer/SECRET/forms/kyc/uploads/abc',
      '/api/v1/viewer/SECRET/forms/kyc/responses',
      '/api/v1/viewer/SECRET/forms/a/b/uploads',
      '/api/v1/viewer//forms/kyc/uploads',
      '/api/v1/presentations/x/forms/kyc/uploads',
      '/api/v1/viewer/SECRET/forms/kyc/uploads?x=1'
    ]) {
      expect(isViewerFormUploadPath(path), path).toBe(false);
    }
  });
});
