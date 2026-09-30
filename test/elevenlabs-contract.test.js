import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

test('ElevenLabs v3 requests do not send unsupported previous_text or next_text fields', () => {
  const start = source.indexOf('async function elevenLabsSynthesize(');
  const end = source.indexOf('\nfunction elevenLabsErrorResponse', start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /model_id:\s*'eleven_v3'/);
  assert.doesNotMatch(block, /previous_text\s*:/);
  assert.doesNotMatch(block, /next_text\s*:/);
  assert.match(block, /language_code:\s*'tr'/);
  assert.match(block, /similarity_boost:\s*0\.85/);
});
