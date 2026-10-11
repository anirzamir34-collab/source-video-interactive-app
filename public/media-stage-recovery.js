// An API key is a billing credential, not the identity of completed source evidence.
// A visual analysis that already passed review remains playable if the independent
// Turkish-media translation stage later runs out of Gemini quota.
export function isGeminiTranslationQuota(error) {
  const code = String(error?.code || error?.error?.code || '').toUpperCase();
  const message = String(error?.message || error?.error?.message || '');
  const status = Number(error?.status || error?.statusCode || error?.error?.status || 0);
  // The media-job poller propagates its public MediaError.code, not Gemini's
  // original HTTP status. E.g. PROVIDER_HTTP_429 or only the Turkish message
  // "Gemini kota veya hız sınırına ulaştı." can reach this client.
  if (/^(?:GEMINI_(?:CREDITS_EXHAUSTED|CREDITS_DEPLETED|QUOTA_OR_CREDITS|DAILY_LIMIT|RATE_LIMITED)|PROVIDER_HTTP_429)$/.test(code)) {
    return true;
  }
  const mentionsGemini = /\bgemini\b/i.test(message);
  const quotaMessage = /(?:kota|hız sınır|limit|quota|rate.limit|resource.exhausted|credit|429)/i.test(message);
  return mentionsGemini && quotaMessage && (
    status === 429 || /(?:kota|hız sınır|quota|rate.limit|resource.exhausted|credit|429)/i.test(message)
  );
}

export function canResumePreparedTurkishMedia({
  session, analysis, sourceKey, mediaModeKey
} = {}) {
  return Boolean(session?.pendingTurkishMedia?.modeKey &&
    session.pendingTurkishMedia.modeKey === mediaModeKey &&
    session.sourceKey === sourceKey &&
    Array.isArray(analysis?.actions) && analysis.actions.length > 0);
}
