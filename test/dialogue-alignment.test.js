import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeDialogueWords, fitNativeDialogueWords } from '../lib/turkish-media/dialogue-alignment.js';

test('native character times remain scoped to their speaker input and transform with measured tempo', () => {
  const characters = [...'Merhaba. Evet.'], starts = characters.map((_, i) => 1 + i / 10), ends = starts.map(value => value + .1);
  const alignment = { characters, character_start_times_seconds: starts, character_end_times_seconds: ends };
  const segments = [{ dialogue_input_index: 0, start_time_seconds: 1, end_time_seconds: 1.8, character_start_index: 0, character_end_index: 8 },
    { dialogue_input_index: 1, start_time_seconds: 1.9, end_time_seconds: 2.4, character_start_index: 9, character_end_index: 14 }];
  const words = nativeDialogueWords(alignment, segments, 0, 'Merhaba.', .8);
  assert.equal(words[0].text, 'Merhaba.'); assert.equal(words[0].start, 0);
  const fitted = fitNativeDialogueWords([{ nativeWords: words, nativeDuration: .8 }], 'Merhaba.', { tempo: 1.08, duration: 1 });
  assert.ok(Math.abs(fitted[0].end - .8 / 1.08) < 1e-8);
  assert.equal(nativeDialogueWords(alignment, segments, 1, 'Merhaba.', .5), null);
  assert.equal(fitNativeDialogueWords([{ nativeWords: words, nativeDuration: .8 }], 'Eksik kelime', { tempo: 1, duration: 1 }), null);
  const trimmed = fitNativeDialogueWords([{ nativeWords: [{ text: 'Evet.', start: .25, end: .65 }], nativeDuration: 1 }],
    'Evet.', { tempo: 1.2, duration: .5, sourceOffset: .22 });
  assert.ok(Math.abs(trimmed[0].start - .03 / 1.2) < 1e-8);
  assert.ok(Math.abs(trimmed[0].end - .43 / 1.2) < 1e-8);
});

test('native clocks subtract only removed pauses before tempo adjustment and retain every word', () => {
  const parts = [{ nativeDuration: 3, nativeWords: [{ text: 'Merhaba.', start: .1, end: .5 },
    { text: 'Evet.', start: 2, end: 2.5 }] }];
  const words = fitNativeDialogueWords(parts, 'Merhaba. Evet.', { duration: 1.5, tempo: 1.2, sourceOffset: .07,
    removedPauses: [{ start: .55, end: 1.86 }] });
  assert.equal(words.length, 2);
  assert.ok(Math.abs(words[0].start - .03 / 1.2) < 1e-8);
  assert.ok(Math.abs(words[1].start - .62 / 1.2) < 1e-8);
  assert.ok(Math.abs(words[1].end - 1.12 / 1.2) < 1e-8);
});
