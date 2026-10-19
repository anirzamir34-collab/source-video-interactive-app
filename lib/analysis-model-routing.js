// Only user-selected, documented deep models may be charged.
export const DEEP_ANALYSIS_MODEL = 'gemini-3.8-flash';
export const ARGON_ANALYSIS_MODEL = 'gemini-4-argon';
export const DEEP_ANALYSIS_MODELS = Object.freeze([DEEP_ANALYSIS_MODEL, ARGON_ANALYSIS_MODEL]);
// The previous 2.5 Lite repeatedly returned MODEL_UNAVAILABLE in production.
// Start directly with the working Lite model instead of billing retries/time.
export const ECONOMY_ANALYSIS_MODEL = 'gemini-3.1-flash-lite';

// Offer a short list of broadly capable storyboard models. The runtime
// catalog/probe still decides which are available for the active API key.
export const PREFERRED_REPAIR_ANALYSIS_MODELS = Object.freeze([
  'gemini-3.8-flash', 'gemini-3.1-flash-lite', 'gemini-4-argon'
]);
export function preferredRepairAnalysisModels(catalog = []) {
  const available = new Set(catalog.filter(isVideoQuestAnalysisModel).map(model =>
    String(model.name || '').replace(/^models\//, '').trim()));
  return PREFERRED_REPAIR_ANALYSIS_MODELS.filter(model => available.has(model));
}

export function isGeminiModelName(value) {
  return /^gemini-[a-z0-9][a-z0-9._-]*$/i.test(String(value || '').trim());
}

// Saved-game repair sends contact-sheet images and requests structured JSON.
// Keep only standard multimodal text-generation variants, not audio, live,
// embeddings, image/video generation or task-specific Gemini models.
export function isVideoQuestAnalysisModel(model = {}) {
  const name = String(model.name || '').replace(/^models\//, '').trim();
  if (!/^gemini-(?:1\.5|2(?:\.\d+)?|3(?:\.\d+)?|4(?:\.\d+)?)-(?:flash(?:-lite)?|pro|argon)(?:-(?:preview|latest|exp|\d{3,4})(?:-[a-z0-9]+)*)?$/i.test(name)) return false;
  const actions = model.supportedActions ?? model.supportedGenerationMethods;
  if (!Array.isArray(actions) || !actions.includes('generateContent')) return false;
  const input = model.inputModalities ?? model.supportedInputModalities;
  if (Array.isArray(input) && !input.some(value => String(value).toLowerCase() === 'image')) return false;
  const output = model.outputModalities ?? model.supportedOutputModalities;
  if (Array.isArray(output) && !output.some(value => String(value).toLowerCase() === 'text')) return false;
  const maxOutput = Number(model.outputTokenLimit);
  if (Number.isFinite(maxOutput) && maxOutput > 0 && maxOutput < 8192) return false;
  return true;
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
