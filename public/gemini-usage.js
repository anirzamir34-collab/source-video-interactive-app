export const emptyGeminiUsage = () => ({ requests: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0, totalTokens: 0 });
export function addGeminiUsage(total, metadata = {}) {
  total.requests += 1;
  total.inputTokens += Number(metadata.promptTokenCount || 0);
  total.outputTokens += Number(metadata.candidatesTokenCount || 0);
  total.thinkingTokens += Number(metadata.thoughtsTokenCount || 0);
  total.totalTokens += Number(metadata.totalTokenCount || 0);
  return total;
}
