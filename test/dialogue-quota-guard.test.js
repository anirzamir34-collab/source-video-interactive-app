import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const appSource = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const serverSource = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

test('dubbing preflight explains that ElevenLabs still depends on dialogue transcription quota', () => {
  assert.match(appSource, /modes\.dubbing \|\| modes\.subtitles/);
  assert.match(appSource, /Gemini konuşma analizi kotası dolu/);
  assert.match(appSource, /ElevenLabs hazır olsa bile Türkçe dublaj için önce konuşmaların çözümlenmesi gerekiyor/);
});

test('dubbing quota badge reflects a blocked dialogue dependency', () => {
  assert.match(appSource, /const dialogueBlocked = !activeGeminiApiKey\(\)[\s\S]*?body\.subtitles\?\.available === false/);
  assert.match(appSource, /ElevenLabs hazır; ancak Türkçe dublaj metni için gereken Gemini konuşma analizi kotası/);
});

test('server returns a specific 429 dialogue quota error before window analysis', () => {
  assert.match(serverSource, /dialogueQuotaBlockedUntil > Date\.now\(\)[\s\S]*?GEMINI_DIALOGUE_QUOTA_BLOCKED/);
  assert.match(serverSource, /return res\.status\(429\)\.json/);
});
