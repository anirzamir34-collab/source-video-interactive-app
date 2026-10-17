// Only user-selected, documented deep models may be charged.
export const DEEP_ANALYSIS_MODEL = 'gemini-3.8-flash';
export const ARGON_ANALYSIS_MODEL = 'gemini-4-argon';
export const DEEP_ANALYSIS_MODELS = Object.freeze([DEEP_ANALYSIS_MODEL, ARGON_ANALYSIS_MODEL]);
// The previous 2.5 Lite repeatedly returned MODEL_UNAVAILABLE in production.
// Start directly with the working Lite model instead of billing retries/time.
export const ECONOMY_ANALYSIS_MODEL = 'gemini-3.1-flash-lite';
export const ECONOMY_FALLBACK_MODEL = 'gemini-2.5-flash-lite';

export function isGeminiModelName(value) {
  return /^gemini-[a-z0-9][a-z0-9._-]*$/i.test(String(value || '').trim());
}

export function isSupportedDeepAnalysisModel(value) {
  return DEEP_ANALYSIS_MODELS.includes(String(value || '').trim());
}

export function analysisModelCandidates(tier = 'economy', env = process.env, requestedDeepModel = '') {
  if (tier === 'deep') {
    const requested = String(requestedDeepModel || '').trim();
    if (requested) {
      if (!isSupportedDeepAnalysisModel(requested)) throw new Error('UNSUPPORTED_DEEP_ANALYSIS_MODEL');
      return [requested];
    }
    return [String(env.GEMINI_ANALYSIS_MODEL || DEEP_ANALYSIS_MODEL).trim()];
  }
  const selected = String(env.GEMINI_ECONOMY_MODEL || ECONOMY_ANALYSIS_MODEL).trim();
  // Avoid retrying the known-unavailable old Lite by default. Operators may
  // opt into an explicitly configured alternative when needed.
  const backup = String(env.GEMINI_ECONOMY_FALLBACK_MODEL || '').trim();
  return backup && selected !== backup ? [selected, backup] : [selected];
}

export function analysisTierFromRequest(value) {
  return value === 'deep' ? 'deep' : 'economy';
}
