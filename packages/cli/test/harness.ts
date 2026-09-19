/**
 * The generic harness lives in `@antasphere/chassis-cli/testing`; it is
 * re-exported here so the tool's tests keep one import. The deck fixtures are
 * the tool's own.
 */
export {
  routedHarness,
  tempConfigEnv,
  type RecordedCall,
  type Route,
  type WireCall
} from '@antasphere/chassis-cli/testing';

export const DECK = {
  id: '11111111-1111-1111-1111-111111111111',
  title: 'Test Deck',
  kind: 'presentation',
  interactive: false,
  currentVersion: 1,
  entryPath: 'index.html',
  hasAgentDoc: false,
  hasDownloads: false,
  ownerUserId: 'u1',
  remixedFrom: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
};

export const VERSION_ROW = {
  presentationId: DECK.id,
  version: 1,
  entryPath: 'index.html',
  sizeBytes: 10,
  fileCount: 1,
  hasAgentDoc: false,
  hasDownloads: false,
  createdBy: 'u1',
  createdByRole: 'owner',
  createdAt: '2026-01-01T00:00:00.000Z'
};
