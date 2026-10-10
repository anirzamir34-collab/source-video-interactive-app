// Select the model from an explicit user mode, not from the developer's
// storyboard detail preset. Detailed frame coverage is identical in both
// modes. Unsupported legacy Lite models may fall back to a current Lite only
// on a true model-unavailable error (never on quota, safety, or bad JSON).
export const DEEP_ANALYSIS_MODEL = 'gemini-3.8-flash';
export const ECONOMY_ANALYSIS_MODEL = 'gemini-2.5-flash-lite';
export const ECONOMY_FALLBACK_MODEL = 'gemini-3.1-flash-lite';

export function analysisModelCandidates(tier = 'economy', env = process.env) {
  if (tier === 'deep') {
    return [String(env.GEMINI_ANALYSIS_MODEL || DEEP_ANALYSIS_MODEL).trim()];
  }
  const selected = String(env.GEMINI_ECONOMY_MODEL || ECONOMY_ANALYSIS_MODEL).trim();
  const backup = String(env.GEMINI_ECONOMY_FALLBACK_MODEL || ECONOMY_FALLBACK_MODEL).trim();
  return selected === backup ? [selected] : [selected, backup];
}

export function analysisTierFromRequest(value) {
  return value === 'deep' ? 'deep' : 'economy';
}
