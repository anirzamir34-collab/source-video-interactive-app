// Keep the response budget intact: reducing it can truncate structured output.
// Gemini 3 supports an explicit effort level; older/custom models keep defaults.
export function geminiGenerationConfig(model, env = process.env) {
  const config = {
    httpOptions: { timeout: /pro/i.test(model) ? 150000 : 90000, retryOptions: { attempts: 1 } },
    responseMimeType: 'application/json',
    temperature: 0.1,
    maxOutputTokens: /pro/i.test(model) ? 32768 : 16384
  };
  if (/^gemini-3(?:[.-]|$)/i.test(model)) {
    const level = env.GEMINI_ANALYSIS_THINKING_LEVEL || 'low';
    if (!['low', 'medium', 'high'].includes(level)) {
      throw new Error('GEMINI_ANALYSIS_THINKING_LEVEL must be low, medium, or high.');
    }
    config.thinkingConfig = { thinkingLevel: level };
  }
  return config;
}
