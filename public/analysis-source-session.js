// Separate the human-readable upload session label from verified video bytes.
// Two files can share a name, length, and lastModified without having the
// same frames or narration. Never continue paid checkpoints for a different
// source in memory merely because those weak metadata fields match.
export function reconcileAnalysisSessionEvidence(session, sourceEvidenceKey) {
  if (!session || typeof session !== 'object') return { changed: false };
  const previous = typeof session.sourceEvidenceKey === 'string' ? session.sourceEvidenceKey : '';
  const next = typeof sourceEvidenceKey === 'string' ? sourceEvidenceKey : '';
  if (!previous || !next || previous === next) {
    if (next) session.sourceEvidenceKey = next;
    return { changed: false };
  }
  session.sourceEvidenceKey = next;
  session.storyboard = null;
  session.sourceTranscript = null;
  session.mediaManifest = null;
  session.mediaModeKey = '';
  session.analysisModeKey = '';
  session.chunkCount = 0;
  session.chunkResults = [];
  session.firstPassResults = {};
  session.protagonistProfile = '';
  session.storyContextMemory = null;
  return { changed: true };
}
