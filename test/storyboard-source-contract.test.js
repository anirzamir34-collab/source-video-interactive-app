import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../lib/analysis-prompt.js', import.meta.url), 'utf8');
const prompt = source.slice(source.indexOf('SOURCE VIDEO IS THE SINGLE SOURCE OF TRUTH.'),
  source.indexOf('Return ONLY valid JSON with this exact shape:'));

test('source analysis does not impose a fixed clip-count or time-based splitting quota', () => {
  assert.doesNotMatch(prompt, /Prefer approximately one meaningful action every 8-18 seconds/);
  assert.doesNotMatch(prompt, /Target \$\{targetActionCount\} distinct/);
  assert.match(prompt, /Continuous unchanging footage is one action regardless of length/);
});

test('intro classification preserves real opening narrative and only removes evidenced non-story material', () => {
  assert.match(prompt, /contiguous non-story material before the first verified narrative event/);
  assert.match(prompt, /If no distinct opening non-story material is demonstrated, report 0/);
  assert.match(prompt, /Do not classify character introductions or genuine dialogue as advertisements/);
});
