const base = 'https://source-video-interactive-app-kyim.onrender.com';
const expected = process.env.GITHUB_SHA;
if (!/^[a-f0-9]{40}$/.test(expected || '')) throw new Error('A concrete production commit SHA is required.');
const deadline = Date.now() + 10 * 60 * 1000;
let last = 'No health response yet.';
while (Date.now() < deadline) {
  try {
    const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(15000), cache: 'no-store' });
    const health = await response.json();
    if (response.ok && health.status === 'ok' && health.deploymentCommit === expected) {
      if (health.turkishMedia?.qualityMode !== 'quality' ||
          health.turkishMedia?.models?.quality !== 'eleven_v4' ||
          health.turkishMedia?.models?.transcription !== 'scribe_v2') {
        throw new Error('The deployed Turkish media models or Quality mode differ from the production contract.');
      }
      if (health.turkishMedia?.translationProvider !== 'gemini' ||
          health.turkishMedia?.openAIRequired !== false ||
          health.turkishMedia?.browserKeysSupported?.elevenLabs !== true ||
          health.turkishMedia?.serverGeminiConfigured !== true) {
        throw new Error('Production must accept browser ElevenLabs plus server Gemini without requiring OpenAI.');
      }
      for (const route of ['/api/turkish-media/capabilities', '/api/turkish-media/voices']) {
        const check = await fetch(`${base}${route}`, { signal: AbortSignal.timeout(10000) });
        const body = await check.json();
        if (check.status !== 401 || body.reason !== 'AUTH_REQUIRED') throw new Error(`Owner authentication check failed: ${route}`);
      }
      console.log(JSON.stringify({ event: 'production_health_verified', url: base, commit: expected,
        healthStatus: response.status, qualityMode: health.turkishMedia.qualityMode,
        transcriptionModel: health.turkishMedia.models.transcription, dubModel: health.turkishMedia.models.quality,
        translationProvider: health.turkishMedia.translationProvider, openAIRequired: health.turkishMedia.openAIRequired,
        browserElevenLabsSupported: health.turkishMedia.browserKeysSupported.elevenLabs,
        serverGeminiConfigured: health.turkishMedia.serverGeminiConfigured,
        mediaAuthentication: 'verified' }));
      process.exit(0);
    }
    last = `HTTP ${response.status}; production commit has not reached the health endpoint yet.`;
  } catch (error) {
    last = error?.name === 'TimeoutError' ? 'Health request timed out.' : String(error?.message || 'Health check failed.');
  }
  await new Promise(resolve => setTimeout(resolve, 10000));
}
throw new Error(`Production verification timed out: ${last}`);
