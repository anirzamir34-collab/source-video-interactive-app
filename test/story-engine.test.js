import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeStoryContexts,
  normalizeStoryContext,
  selectDiverseStoryActions,
  sensoryActionMeta,
  storyChoiceIntentKey,
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

test('sensory cues require direct evidence and sufficient confidence', () => {
  assert.deepEqual(sensoryActionMeta({ audioIntensity: 'high', sensoryConfidence: 0.9 }).cues, []);
  assert.deepEqual(sensoryActionMeta({
    audioIntensity: 'high',
    nonSpeechAudio: 'moan',
    gazeIntensity: 'mutual',
    observedAffect: 'tense',
    bodyResponse: 'rhythmic',
    sensoryConfidence: 0.86,
    sensoryEvidence: 'Ses yükseliyor; iki karakter karşılıklı bakıyor ve görünür hareket ritmik.'
  }).cues, ['Yoğun inleme', 'Karşılıklı yoğun bakış', 'Gergin görünüm']);
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

test('collapses synonymous story choices while preserving distinct actions', () => {
  assert.equal(storyChoiceIntentKey({ label: 'Kızı izle' }), 'observe');
  assert.equal(storyChoiceIntentKey({ label: 'Kızı süz' }), 'observe');
  assert.equal(storyChoiceIntentKey({ label: 'Kıza bak' }), 'observe');

  const choices = selectDiverseStoryActions([
    { actionId: 'watch', label: 'Kızı izle' },
    { actionId: 'scan', label: 'Kızı süz' },
    { actionId: 'look', label: 'Kıza bak' },
    { actionId: 'approach', label: 'Kıza yaklaş' },
    { actionId: 'talk', label: 'Kızla konuş' },
    { actionId: 'leave', label: 'Oradan uzaklaş' }
  ], 3);

  assert.deepEqual(choices.map((choice) => choice.actionId), ['watch', 'approach', 'talk']);
});
