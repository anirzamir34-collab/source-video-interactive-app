export const CLOUDFLARE_STORYBOARD_MODEL = '@cf/qwen/qwen3.8-27b';

export function cloudflareCredentials(req) {
  const accountId = String(req.get('x-cloudflare-account-id') || '').trim();
  const token = String(req.get('x-cloudflare-api-token') || '').trim();
  if (!/^[a-f0-9]{32}$/i.test(accountId) || token.length < 20 || token.length > 512 || /\s/.test(token)) return null;
  return { accountId, token };
}

export async function runCloudflareStoryboard({ accountId, token, prompt, files, fetchImpl = fetch }) {
  const content = [{ type: 'text', text: prompt }, ...files.map(file => ({
    type: 'image_url', image_url: { url: `data:${file.mimetype || 'image/jpeg'};base64,${file.buffer.toString('base64')}` }
  }))];
  const response = await fetchImpl(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${CLOUDFLARE_STORYBOARD_MODEL}`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content }], max_tokens: 8192, temperature: 0.1 }),
      signal: AbortSignal.timeout(90000) }
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    const code = response.status === 429 ? 'CLOUDFLARE_QUOTA' : response.status === 401 || response.status === 403
      ? 'CLOUDFLARE_AUTH' : 'CLOUDFLARE_ANALYSIS_ERROR';
    const detail = String(body.errors?.[0]?.message || body.error || '').slice(0, 240);
    throw Object.assign(new Error(detail || 'Cloudflare analiz isteği başarısız oldu.'), { code, statusCode: response.status });
  }
  const result = body.result || body;
  const text = typeof result.response === 'string' ? result.response
    : typeof result.response?.content === 'string' ? result.response.content
      : typeof result.choices?.[0]?.message?.content === 'string' ? result.choices[0].message.content : '';
  if (!text) throw Object.assign(new Error('Cloudflare yapılandırılmış analiz yanıtı vermedi.'), { code: 'CLOUDFLARE_EMPTY_RESPONSE' });
  const usage = result.usage || body.usage || {};
  return { text, usageMetadata: {
    promptTokenCount: Number(usage.prompt_tokens || usage.input_tokens || 0),
    candidatesTokenCount: Number(usage.completion_tokens || usage.output_tokens || 0),
    totalTokenCount: Number(usage.total_tokens || 0)
  } };
}
