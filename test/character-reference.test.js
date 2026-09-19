import test from 'node:test';
import assert from 'node:assert/strict';
import { bindActionCharacter } from '../public/character-identity.js';
import { resolveLeadingCharacterReference } from '../public/character-reference.js';
import { mergeStoryContexts } from '../public/story-engine.js';

test('verified references use the appropriate Turkish grammatical case without changing the action', () => {
  assert.equal(resolveLeadingCharacterReference('Onun elini tut', { name: 'Meral' }), "Meral'in elini tut");
  assert.equal(resolveLeadingCharacterReference('Onu dinle', { name: 'Derya' }), "Derya'yı dinle");
  assert.equal(resolveLeadingCharacterReference('Ona sor', { name: 'Deniz' }), "Deniz'e sor");
  assert.equal(resolveLeadingCharacterReference('Onunla konuş', { role: 'kız arkadaşı' }), 'Kız arkadaşıyla konuş');
  assert.equal(resolveLeadingCharacterReference('Onun elini tut', { role: 'sevgilisi' }), 'Sevgilisinin elini tut');
});

test('only the bound target placeholder is replaced, and unknown identity remains unchanged', () => {
  const context = { name: 'Meral', targetIds: ['PARTNER_A'] };
  assert.equal(resolveLeadingCharacterReference("Partner A'nın sözünü dinle", context), "Meral'in sözünü dinle");
  assert.equal(resolveLeadingCharacterReference("Partner B'nin sözünü dinle", context), "Partner B'nin sözünü dinle");
  assert.equal(resolveLeadingCharacterReference('Onun sözünü dinle'), 'Onun sözünü dinle');
});

test('names reach both source and narrative labels while ambiguous group targets are not reassigned', () => {
  const context = { characters: ['Meral', 'Deniz', 'Aylin'].map((name, index) => ({
    id: `id-${index}`, participantTrackId: `track-${index}`, displayName: name,
    evidenceLevel: 'fact', confidence: 0.94, evidence: `Konuşmada ${name} olarak tanıtılıyor.`
  })) };
  const source = { label: 'Onun sözünü dinle', narrativeChoiceLabel: 'Ona sor', sourceVerified: true,
    primaryCharacterId: 'id-1', partnerTrackId: 'track-1', subjectTrackId: 'track-0',
    participantTrackIds: ['track-0', 'track-1', 'track-2'], startTime: 30, endTime: 35 };
  const result = bindActionCharacter(source, context);
  assert.equal(result.label, "Deniz'in sözünü dinle");
  assert.equal(result.narrativeChoiceLabel, "Deniz'e sor");
  assert.equal(result.startTime, 30);
  const conflict = bindActionCharacter({ ...source, partnerTrackId: 'track-2' }, context);
  assert.equal(conflict.identityResolution, 'conflict');
  assert.equal(conflict.label, source.label);
});

test('supported speaker mappings survive a later visual-only chunk without turning a voice label into a name', () => {
  const first = { characters: [{ id: 'visual-a', participantTrackId: 'track-a', displayName: 'Meral',
    confidence: 0.9, evidenceLevel: 'fact', evidence: '10sn: kendini Meral olarak tanıtıyor.',
    speakerIds: ['speaker-2'], voiceMatchEvidence: '10sn: görünür konuşmacı ile speaker-2 eşleşiyor.' }] };
  const next = { characters: [{ ...first.characters[0], confidence: 0.95, speakerIds: [], voiceMatchEvidence: '' }] };
  const merged = mergeStoryContexts([first, next]);
  assert.deepEqual(merged.characters[0].speakerIds, ['speaker-2']);
  assert.equal(merged.characters[0].displayName, 'Meral');
});
