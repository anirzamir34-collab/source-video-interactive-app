// An API key is a billing credential, not the identity of completed source evidence.
// A visual analysis that already passed review remains playable if the independent
// Turkish-media translation stage later runs out of Gemini quota.
export function isGeminiTranslationQuota(error) {
  const code = String(error?.code || '').toUpperCase();
  if (/^GEMINI_(?:CREDITS_EXHAUSTED|CREDITS_DEPLETED|QUOTA_OR_CREDITS|DAILY_LIMIT|RATE_LIMITED)$/.test(code)) return true;
  return Number(error?.status) === 429 && /gemini|quota|kota/i.test(String(error?.message || ''));
}

export function canResumePreparedTurkishMedia({
  session, analysis, sourceKey, mediaModeKey
} = {}) {
  return Boolean(session?.pendingTurkishMedia?.modeKey &&
    session.pendingTurkishMedia.modeKey === mediaModeKey &&
    session.sourceKey === sourceKey &&
    Array.isArray(analysis?.actions) && analysis.actions.length > 0);
}
