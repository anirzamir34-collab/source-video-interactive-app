import test from 'node:test';
import assert from 'node:assert/strict';
import { exportGame, importGame } from '../public/saved-games.js';
import { synchronizeExportIdentity } from '../public/export-identity.js';

const fact = (id, track, displayName) => ({
  id, participantTrackId: track, displayName,
  evidenceLevel: 'fact', confidence: 0.96, evidence: 'Zaman uyumlu diyalogda doğrulandı.'
});
const characters = [fact('PARENT', 'MAIN_MALE', 'Üvey baba'),
  fact('DAUGHTER', 'PARTNER_A', 'Üvey kız'), fact('GUEST', 'PARTNER_B', 'Meral')];
const baseAction = {
  subjectTrackId: 'MAIN_MALE', primaryCharacterId: 'PARTNER_A',
  partnerTrackId: 'PARTNER_A', involvedCharacterIds: ['MAIN_MALE', 'PARTNER_A'],
  label: 'Karakter A ile konuş', narrativeChoiceLabel: 'Partner A ile konuş',
  primaryCharacterLabel: 'PARTNER_A'
};
const analysis = actions => ({ storyContext: { characters }, actions });

test('export-only synchronization corrects uniquely identified ordinary dialogue placeholders', () => {
  const original = analysis([{ ...baseAction, adultScene: false, actionType: 'dialogue' }]);
  const next = synchronizeExportIdentity(original);
  const [item] = next.actions;
  assert.equal(item.primaryCharacterDisplayNameFact, 'Üvey kız');
  assert.equal(item.partnerDisplayNameFact, 'Üvey kız');
  assert.equal(item.subjectDisplayNameFact, 'Üvey baba');
  assert.equal(item.label, 'Üvey kız ile konuş');
  assert.equal(item.narrativeChoiceLabel, 'Üvey kız ile konuş');
  assert.equal(item.primaryCharacterLabel, 'Üvey kız');
  assert.equal(original.actions[0].label, 'Karakter A ile konuş');
  assert.deepEqual(synchronizeExportIdentity(next), next);
});

test('intimate actions retain original playable copy and only update neutral factual metadata', () => {
  const source = { ...baseAction, adultScene: true, actionType: 'position',
    label: 'Kesiti oynat', narrativeChoiceLabel: 'Karakter A · Kesiti oynat',
    primaryCharacterLabel: 'Karakter A', startTime: 211.158 };
  const original = analysis([source]);
  const exported = synchronizeExportIdentity(original).actions[0];
  assert.equal(exported.primaryCharacterDisplayNameFact, 'Üvey kız');
  assert.equal(exported.subjectDisplayNameFact, 'Üvey baba');
  assert.equal(exported.label, 'Kesiti oynat');
  assert.equal(exported.narrativeChoiceLabel, 'Karakter A · Kesiti oynat');
  assert.equal(exported.primaryCharacterLabel, 'Karakter A');
  assert.equal(source.primaryCharacterDisplayNameFact, undefined);
  assert.equal(exported.startTime, 211.158);
});

test('conflicting and absent tracks never borrow the registry role', () => {
  const conflict = { ...baseAction, adultScene: false, actionType: 'dialogue',
    partnerTrackId: 'PARTNER_B', involvedCharacterIds: ['MAIN_MALE', 'PARTNER_A', 'PARTNER_B'] };
  const missing = { ...baseAction, adultScene: false, actionType: 'dialogue', primaryCharacterId: 'MISSING' };
  for (const source of [conflict, missing]) {
    const bound = synchronizeExportIdentity(analysis([source])).actions[0];
    assert.equal(bound.primaryCharacterDisplayNameFact, '');
    assert.equal(bound.label, 'Karakter A ile konuş');
  }
  const uncertain = { ...characters[1], evidenceLevel: 'inference' };
  const item = synchronizeExportIdentity({ storyContext: { characters: [characters[0], uncertain] },
    actions: [{ ...baseAction, adultScene: false, actionType: 'dialogue' }] }).actions[0];
  assert.equal(item.primaryCharacterDisplayNameFact, '');
  assert.equal(item.label, 'Karakter A ile konuş');
});

test('the final VQGAME header synchronizes only its exported JSON and preserves media bytes', async () => {
  const input = {
    title: 'Test video', fileName: 'test.mp4', sourceKind: 'file',
    duration: 300, video: new Blob(['video-data'], { type: 'video/mp4' }), dubAudio: null,
    turkishMedia: null, payload: { dialogue: null, analysis: analysis([
      { ...baseAction, adultScene: false, actionType: 'dialogue', sourceVerified: true },
      { ...baseAction, adultScene: true, actionType: 'position', startTime: 211.158, sourceVerified: true }
    ]) }
  };
  const backup = exportGame(input);
  const restored = await importGame(backup);
  assert.equal(restored.payload.analysis.actions[0].label, 'Üvey kız ile konuş');
  assert.equal(restored.payload.analysis.actions[1].label, 'Karakter A ile konuş');
  assert.equal(restored.payload.analysis.actions[1].primaryCharacterDisplayNameFact, 'Üvey kız');
  assert.equal(input.payload.analysis.actions[0].label, 'Karakter A ile konuş');
  assert.equal(await restored.video.text(), 'video-data');
});
