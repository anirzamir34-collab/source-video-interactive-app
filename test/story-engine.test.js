import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeStoryContexts,
  normalizeStoryContext,
  storyChoiceLabelForAction
} from '../public/story-engine.js';

test('uses narrative choice only when evidence is strong enough', () => {
  assert.equal(storyChoiceLabelForAction({
    label: 'Kadına yaklaş',
    narrativeChoiceLabel: 'Eski kız arkadaşınla geçmişi konuş',
    storyEvidenceLevel: 'fact',
    storyConfidence: 0.92,
    storyEvidence: 'Diyalogda ayrılıktan açıkça söz ediliyor.'
  }), 'Eski kız arkadaşınla geçmişi konuş');

  assert.equal(storyChoiceLabelForAction({
    label: 'Kadına yaklaş',
    narrativeChoiceLabel: 'Eski kız arkadaşınla geçmişi konuş',
    storyEvidenceLevel: 'inference',
    storyConfidence: 0.70,
    storyEvidence: 'Samimi davranıyorlar.'
  }), 'Kadına yaklaş');
});

test('normalizes story evidence without upgrading uncertainty', () => {
  const context = normalizeStoryContext({
    synopsisTr: 'Erkek eve gelir.',
    relationships: [{ from: 'MAIN_MALE', to: 'WOMAN_1', relation: 'eski sevgili', evidenceLevel: 'maybe', confidence: 2 }],
    inferences: [{ text: 'Birbirlerini tanıyor olabilirler.', confidence: 0.65 }],
    unknowns: ['İlişkinin kesin türü']
  });
  assert.equal(context.relationships[0].evidenceLevel, 'unknown');
  assert.equal(context.relationships[0].confidence, 1);
  assert.equal(context.inferences[0].confidence, 0.65);
});

test('merges chunk story context while keeping facts and unknowns', () => {
  const merged = mergeStoryContexts([
    { storyContext: { synopsisTr: 'Erkek eve gelir.', facts: [{ text: 'Erkek kapıdan içeri girer.', evidence: 'Görüntü' }], unknowns: ['Kadının kimliği'] } },
    { storyContext: { synopsisTr: 'İkili konuşur.', facts: [{ text: 'İkili salonda konuşur.', evidence: 'Görüntü' }], unknowns: ['Kadının kimliği'] } }
  ]);
  assert.match(merged.synopsisTr, /Erkek eve gelir/);
  assert.equal(merged.facts.length, 2);
  assert.equal(merged.unknowns.length, 1);
});
