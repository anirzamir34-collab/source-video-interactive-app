// Select a sparse, full-video character survey before per-chapter identity locking.
// Sampling spans the *whole* storyboard; the first chapter is not authoritative.
export function surveySheetIndices(total, maximum = 8) {
  const n = Math.max(0, Math.floor(Number(total) || 0));
  const count = Math.min(n, Math.max(1, Math.floor(Number(maximum) || 8)));
  if (!count) return [];
  if (count === 1) return [0];
  return [...new Set(Array.from({ length: count }, (_, index) =>
    Math.round(index * (n - 1) / (count - 1))))];
}

// Never promote a model guess into a character lock. An incomplete or ambiguous
// survey keeps the usual source-based tracking available without guessing.
export function normalizeProtagonistSurvey(survey = {}) {
  const confidence = Number(survey?.confidence);
  const maleCount = Number(survey?.maleCount);
  const profile = String(survey?.protagonistProfile || '').trim().slice(0, 500);
  const evidence = String(survey?.visualEvidence || '').trim().slice(0, 500);
  const unique = survey?.unambiguous === true;
  const accepted = survey?.visibleAdultMale === true && unique &&
    Number.isFinite(confidence) && confidence >= 0.72 && profile && evidence &&
    Number.isInteger(maleCount) && maleCount >= 1;
  return {
    profile: accepted ? profile : '',
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    maleCount: Number.isInteger(maleCount) ? Math.max(0, maleCount) : 0,
    resolved: Boolean(accepted),
    reason: accepted ? 'VIDEO_WIDE_VISUAL_PROFILE' : 'UNRESOLVED',
  };
}
