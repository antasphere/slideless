/**
 * The TYPE half of the public surface of `@slideless/sdk` (PRDCT-2530,
 * verifier F-5): every exported type, imported BY NAME, so that a name dropped
 * from `src/index.ts` (its own interfaces, or the re-export list over
 * `@antasphere/chassis-sdk`) fails `typecheck` with TS2305. No test runs this
 * file; `tsconfig.test.json` compiles it. The runtime names are pinned by
 * `exports.test.ts`.
 */
import type {
  AnnotationListParams,
  AuditListParams,
  AuditListResponse,
  ClientOptions,
  FileUploaded,
  FormResponseFilesZipParams,
  FormResponseListParams,
  IdempotentRequestOptions,
  InvitationAccepted,
  ListParams,
  PlatformApiError,
  PlatformClient,
  PresentationListParams,
  ReferenceListParams
} from '../src/index.js';

/** One use per name: an unused import would be dropped by a formatter pass. */
export type SdkPublicTypes = [
  AnnotationListParams,
  AuditListParams,
  AuditListResponse,
  ClientOptions,
  FileUploaded,
  FormResponseFilesZipParams,
  FormResponseListParams,
  IdempotentRequestOptions,
  InvitationAccepted,
  ListParams,
  PlatformApiError,
  PlatformClient,
  PresentationListParams,
  ReferenceListParams
];
