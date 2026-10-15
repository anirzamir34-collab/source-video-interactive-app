// Keep structured action output intact, but bound reasoning and image tokens.
// Gemini 3/4 support model-side media resolution on GenerateContentConfig.
export function geminiGenerationConfig(model, env = process.env) {
  const argon = model === 'gemini-4-argon';
  const pro = /pro/i.test(model);
  const config = {
    httpOptions: { timeout: argon ? 210000 : pro ? 150000 : 90000, retryOptions: { attempts: 1 } },
    responseMimeType: 'application/json',
    maxOutputTokens: pro ? 32768 : 16384
  };
  // Gemini 4 ignores sampling controls and defaults to medium thinking.
  // Explicit low thinking protects the selected Argon user's token budget.
  if (!argon) config.temperature = 0.1;
  if (/^gemini-[34](?:[.-]|$)/i.test(model)) {
    const level = env.GEMINI_ANALYSIS_THINKING_LEVEL || 'low';
    if (!['low', 'medium', 'high'].includes(level)) {
      throw new Error('GEMINI_ANALYSIS_THINKING_LEVEL must be low, medium, or high.');
    }
    config.thinkingConfig = { thinkingLevel: level };
    // Medium keeps small changes legible in each 12-frame contact sheet.
    config.mediaResolution = 'MEDIA_RESOLUTION_MEDIUM';
  }
  return config;
}
