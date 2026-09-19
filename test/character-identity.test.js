import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { bindActionCharacter, verifiedCharacterName } from '../public/character-identity.js';
import { mergeStoryContexts, storyChoiceLabelForAction } from '../public/story-engine.js';
import { mergeSecondPassReview } from '../public/engine-hardening.js';

const named = (id, participantTrackId, displayName) => ({
  id, participantTrackId, displayName, evidenceLevel: 'fact', confidence: 0.94,
  evidence: `Diyalogda kendisini ${displayName} olarak tanıtıyor.`
});
const cast = { characters: [named('DANNY', 'MAIN_MALE', 'Danny'), named('MERAL', 'PARTNER_A', 'Meral'), named('DENIZ', 'PARTNER_B', 'Deniz')] };
cast.relationships = [{ from: 'DANNY', to: 'MERAL', relation: 'eşi', evidenceLevel: 'fact', confidence: 0.96,
  evidence: 'Diyalogda Danny, Meral’i eşi olarak tanıtıyor.' }];

test('a characters-only chunk is retained and later verified names replace vague early labels', () => {
  const first = { currentSceneTitle: 'Toplantı', characters: [{ id: 'early-a', participantTrackId: 'PARTNER_A', displayName: "Danny’nin kadını", evidenceLevel: 'unknown' }] };
  const result = mergeStoryContexts([first, { characters: [cast.characters[1]] }]);
  assert.equal(result.characters.length, 1);
  assert.equal(result.characters[0].displayName, 'Meral');
  assert.equal(result.currentSceneTitle, 'Toplantı');
  assert.equal(mergeStoryContexts([{ characters: [cast.characters[1]] }]).characters.length, 1);
  assert.ok(result.characters[0].characterIds.includes('early-a'));
  const action = bindActionCharacter({ label: 'Konuşmayı sürdür', primaryCharacterId: 'early-a', involvedCharacterIds: ['early-a'] }, result);
  assert.equal(storyChoiceLabelForAction(action), 'Konuşmayı sürdür · Meral');
});

test('two-person actions bind the counterparty by IDs instead of the generated label', () => {
  const action = bindActionCharacter({
    label: 'Dosyayı uzat', primaryCharacterLabel: "Danny’nin kadını", partnerLabel: 'Danny',
    subjectTrackId: 'MAIN_MALE', partnerTrackId: 'PARTNER_A', involvedCharacterIds: ['DANNY', 'MERAL'],
    participantTrackIds: ['MAIN_MALE', 'PARTNER_A'], startTime: 10, endTime: 14, sourceVerified: true
  }, cast);
  assert.equal(action.primaryCharacterLabel, 'Meral');
  assert.equal(action.partnerLabel, 'Meral');
  assert.equal(action.identityResolution, 'verified');
  assert.equal(action.relationshipDisplayLabel, 'Danny ile ilişkisi: eşi');
  assert.match(storyChoiceLabelForAction(action), /Danny ile ilişkisi: eşi/);
  assert.deepEqual([action.startTime, action.endTime, action.sourceVerified], [10, 14, true]);
});

test('family and relationship facts appear only in ordinary choices with exact IDs', () => {
  const family = { ...cast, relationships: [
    { from: 'DANNY', to: 'DENIZ', relation: 'kızı', evidenceLevel: 'fact', confidence: 0.93, evidence: 'Diyalogda açıkça kızı deniyor.' }
  ] };
  const ordinary = bindActionCharacter({ label: 'Soruyu sor', subjectTrackId: 'MAIN_MALE', primaryCharacterId: 'DENIZ',
    involvedCharacterIds: ['DANNY', 'DENIZ'], adultScene: false }, family);
  assert.equal(storyChoiceLabelForAction(ordinary), 'Soruyu sor · Deniz · Danny ile ilişkisi: kızı');
  const intimate = bindActionCharacter({ label: 'Kesiti oynat', subjectTrackId: 'MAIN_MALE', primaryCharacterId: 'DENIZ',
    partnerTrackId: 'PARTNER_B', involvedCharacterIds: ['DANNY', 'DENIZ'], adultScene: true }, family);
  assert.equal(intimate.relationshipDisplayLabel, '');
  assert.equal(storyChoiceLabelForAction(intimate), 'Kesiti oynat · Deniz');
});

test('uncertain, unsupported and conflicting relationships stay out of choices', () => {
  for (const relationships of [
    [{ from: 'DANNY', to: 'MERAL', relation: 'eşi', evidenceLevel: 'inference', confidence: 0.99, evidence: 'Yakın görünüyorlar.' }],
    [{ from: 'DANNY', to: 'MERAL', relation: 'eşi', evidenceLevel: 'fact', confidence: 0.4, evidence: 'Belirsiz.' }],
    [{ from: 'DANNY', to: 'MERAL', relation: 'eşi', evidenceLevel: 'fact', confidence: 0.9, evidence: '' }],
    [cast.relationships[0], { ...cast.relationships[0], relation: 'kardeşi' }]
  ]) {
    const action = bindActionCharacter({ label: 'Konuş', subjectTrackId: 'MAIN_MALE', primaryCharacterId: 'MERAL',
      involvedCharacterIds: ['DANNY', 'MERAL'] }, { ...cast, relationships });
    assert.equal(action.relationshipDisplayLabel, '');
  }
});

test('an explicit addressed character is preserved in a group scene', () => {
  const action = bindActionCharacter({ label: 'Cevabını dinle', primaryCharacterId: 'DENIZ', involvedCharacterIds: ['DANNY', 'MERAL', 'DENIZ'] }, cast);
  assert.equal(action.primaryCharacterLabel, 'Deniz');
  assert.equal(action.primaryCharacterId, 'PARTNER_B');
});

test('same names never merge distinct tracks and contradictory names do not silently replace each other', () => {
  const merged = mergeStoryContexts([{ characters: [cast.characters[1], named('OTHER_MERAL', 'PARTNER_B', 'Meral')] },
    { characters: [named('MERAL', 'PARTNER_A', 'Leyla')] }]);
  assert.equal(merged.characters.length, 2);
  assert.equal(merged.characters[0].identityConflict, true);
  assert.equal(merged.characters[1].displayName, 'Meral');
  const action = bindActionCharacter({ label: 'Soruyu dinle', partnerTrackId: 'PARTNER_A' }, merged);
  assert.equal(action.primaryCharacterLabel, 'Karakter A');
  assert.equal(action.identityResolution, 'conflict');
});

test('absent participants, missing IDs and ambiguous group targets never borrow another name', () => {
  const absent = bindActionCharacter({ label: 'Soruyu dinle', primaryCharacterId: 'DENIZ', primaryCharacterLabel: 'Deniz', involvedCharacterIds: ['DANNY', 'MERAL'] }, cast);
  assert.equal(absent.primaryCharacterLabel, '');
  assert.equal(absent.identityResolution, 'conflict');
  const group = bindActionCharacter({ label: 'Cevabı dinle', subjectTrackId: 'MAIN_MALE', involvedCharacterIds: ['DANNY', 'MERAL', 'DENIZ'], primaryCharacterLabel: 'Meral' }, cast);
  assert.equal(group.primaryCharacterLabel, '');
  const missing = bindActionCharacter({ label: 'Konuş', primaryCharacterId: 'MISSING', primaryCharacterLabel: 'Meral' }, cast);
  assert.equal(missing.primaryCharacterLabel, '');
});

test('unconfirmed names stay unconfirmed and possessive descriptions are not proper names', () => {
  for (const record of [
    { ...cast.characters[1], evidenceLevel: 'inference' },
    { ...cast.characters[1], confidence: NaN },
    { ...cast.characters[1], evidence: '' },
    { ...cast.characters[1], displayName: "Danny’nin kadını" }
  ]) assert.equal(verifiedCharacterName(record), '');
  const action = bindActionCharacter({ label: 'Konuşmayı sürdür', narrativeChoiceLabel: "Danny’nin kadınıyla konuş", partnerTrackId: 'PARTNER_A' }, { ...cast, relationships: [] });
  assert.equal(storyChoiceLabelForAction(action), 'Konuşmayı sürdür · Meral');
  for (const label of ['Danny nin kadınıyla konuş', 'Dannynin kadınına bak']) {
    assert.equal(bindActionCharacter({ label, partnerTrackId: 'PARTNER_A' }, cast).label, 'Kesiti oynat');
  }
});

test('real analysis normalization applies stable character mapping to main and extra actions', () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const begin = source.indexOf('function normalizeAnalysis(');
  const end = source.indexOf('\nfunction initializeInteractive(', begin);
  const scope = vm.createContext({ bindActionCharacter, mergeStoryContexts,
    assignPositionOccurrenceIds() {}, normalizeOutcomeUnlockProgress: () => 82,
    ANALYSIS_SCHEMA_VERSION: 5, ENGINE_VERSION: 'test' });
  vm.runInContext(source.slice(begin, end), scope);
  const analysis = scope.normalizeAnalysis({ storyContext: cast, actions: ['main', 'bonus'].map((actionLevel, i) => ({
    actionId: `a-${i}`, label: 'Cevabı dinle', primaryCharacterId: 'MERAL',
    involvedCharacterIds: ['DANNY', 'MERAL'], primaryCharacterLabel: "Danny’nin kadını",
    actionLevel, startTime: i * 10, endTime: i * 10 + 5, sourceVerified: true
  })) });
  assert.equal(analysis.actions.length, 2);
  for (const action of analysis.actions) assert.equal(action.primaryCharacterLabel, 'Meral');
});

test('a partial second-pass review cannot erase the first-pass character registry', () => {
  const action = { actionId: 'one', startTime: 10, endTime: 15, label: 'Cevabı dinle', primaryCharacterId: 'MERAL' };
  const merged = mergeSecondPassReview({ storyContext: cast, actions: [action] },
    { storyContext: {}, actions: [action] }, [action]);
  assert.equal(merged.storyContext.characters.length, 3);
  assert.equal(bindActionCharacter(merged.actions[0], merged.storyContext).primaryCharacterLabel, 'Meral');
});
