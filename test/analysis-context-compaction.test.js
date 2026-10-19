import test from 'node:test';
import assert from 'node:assert/strict';
import { compactDialogueSegments, compactStoryMemory } from '../public/analysis-context-compaction.js';

test('dialogue rows drop duplicated text fields but keep every line and translation', () => {
  const rows = compactDialogueSegments([
    { segmentId: 's1', speakerId: 'A', startTime: 1, endTime: 2, originalText: 'Hello', text: 'Hello',
      textTr: 'Merhaba', turkishText: 'Merhaba', gender: 'uncertain', emotion: 'calm', speakerName: '', confidence: 0.912 }
  ]);
  assert.deepEqual(rows, [{ segmentId: 's1', speakerId: 'A', startTime: 1, endTime: 2,
    originalText: 'Hello', textTr: 'Merhaba', emotion: 'calm', confidence: 0.91 }]);
});

test('story memory keeps every fact and only shortens long evidence strings', () => {
  const memory = { synopsisTr: 'Özet', facts: [{ text: 'Gerçek', confidence: 1, evidence: 'x'.repeat(360) }],
    inferences: [{ text: 'Çıkarım', confidence: 0.6, evidence: 'kısa' }], unknowns: ['Belirsiz'],
    characters: [{ id: 'c1', description: 'Uzun açıklama', evidence: 'y'.repeat(300) }], relationships: [] };
  const compact = compactStoryMemory(memory);
  assert.equal(compact.facts[0].text, 'Gerçek');
  assert.ok(compact.facts[0].evidence.length <= 110);
  assert.equal(compact.inferences[0].evidence, 'kısa');
  assert.deepEqual(compact.unknowns, ['Belirsiz']);
  assert.equal(compact.characters[0].description, 'Uzun açıklama');
  assert.ok(JSON.stringify(compact).length < JSON.stringify(memory).length);
});
