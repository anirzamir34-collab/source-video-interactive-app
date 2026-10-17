import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileAnalysisSessionEvidence } from '../public/analysis-source-session.js';

function retainedSession() {
  return {
    sourceKey: 'file:identical-name.mp4:1000:77',
    sourceEvidenceKey: 'source-content-a',
    storyboard: { sheets: [new Blob(['a'])], timestamps: [0, 1], duration: 2 },
    sourceTranscript: { segments: [{ text: 'Old audio' }] },
    mediaManifest: { jobId: 'previous-paid-dub' },
    mediaModeKey: 'old-media-mode',
    analysisModeKey: 'old-analysis-mode',
    chunkCount: 40,
    chunkResults: Array.from({ length: 40 }, (_, index) => ({ available: true, chapter: index })),
    firstPassResults: { 0: { content: 'previous evidence' } },
    protagonistProfile: 'old protagonist',
    storyContextMemory: { characters: [{ id: 'old' }] }
  };
}

test('identical source bytes preserve all 40 paid chapters, storyboard and transcript', () => {
  const session = retainedSession();
  const original = structuredClone(session);
  const r = reconcileAnalysisSessionEvidence(session, 'source-content-a');
  assert.deepEqual(r, { changed: false });
  assert.deepEqual(session, original);
});

test('same metadata and different source bytes never inherit another video’s chapters or cast', () => {
  const session = retainedSession();
  const key = session.sourceKey;
  const r = reconcileAnalysisSessionEvidence(session, 'source-content-b');
  assert.deepEqual(r, { changed: true });
  assert.equal(session.sourceKey, key, 'weak metadata label alone is never trusted');
  assert.equal(session.sourceEvidenceKey, 'source-content-b');
  assert.equal(session.storyboard, null);
  assert.equal(session.sourceTranscript, null);
  assert.equal(session.mediaManifest, null);
  assert.equal(session.analysisModeKey, '');
  assert.equal(session.mediaModeKey, '');
  assert.equal(session.chunkCount, 0);
  assert.deepEqual(session.chunkResults, []);
  assert.deepEqual(session.firstPassResults, {});
  assert.equal(session.protagonistProfile, '');
  assert.equal(session.storyContextMemory, null);
});

test('missing or legacy fingerprint cannot authorize reuse of earlier paid media results', () => {
  const session = retainedSession();
  assert.deepEqual(reconcileAnalysisSessionEvidence(session, null), { changed: true });
  assert.deepEqual(session.chunkResults, []);
  assert.equal(session.storyboard, null);
  assert.equal(session.sourceTranscript, null);
  const legacy = retainedSession();
  legacy.sourceEvidenceKey = '';
  assert.deepEqual(reconcileAnalysisSessionEvidence(legacy, 'new-content'), { changed: true });
  assert.deepEqual(legacy.chunkResults, []);
  assert.equal(legacy.sourceEvidenceKey, 'new-content');
  const blankSession = { storyboard: null };
  assert.deepEqual(reconcileAnalysisSessionEvidence(blankSession, 'first-content'), { changed: false });
  assert.equal(blankSession.sourceEvidenceKey, 'first-content');
});

test('new empty upload session does not invalidate a valid source key', () => {
  const session = { sourceEvidenceKey: 'old', storyboard: null, chunkResults: [], sourceTranscript: null };
  assert.deepEqual(reconcileAnalysisSessionEvidence(session, 'new'), { changed: false });
  assert.equal(session.sourceEvidenceKey, 'new');
});
