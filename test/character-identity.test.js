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
  assert.equal(storyChoiceLabelForAction(action), 'Eşi · Dosyayı uzat');
  assert.deepEqual([action.startTime, action.endTime, action.sourceVerified], [10, 14, true]);
});

test('family and relationship facts appear only in ordinary choices with exact IDs', () => {
  const family = { ...cast, relationships: [
    { from: 'DANNY', to: 'DENIZ', relation: 'kızı', evidenceLevel: 'fact', confidence: 0.93, evidence: 'Diyalogda açıkça kızı deniyor.' }
  ] };
  const ordinary = bindActionCharacter({ label: 'Soruyu sor', subjectTrackId: 'MAIN_MALE', primaryCharacterId: 'DENIZ',
    involvedCharacterIds: ['DANNY', 'DENIZ'], adultScene: false }, family);
  assert.equal(storyChoiceLabelForAction(ordinary), 'Kızı · Soruyu sor');
  const intimate = bindActionCharacter({ label: 'Kesiti oynat', subjectTrackId: 'MAIN_MALE', primaryCharacterId: 'DENIZ',
    partnerTrackId: 'PARTNER_B', involvedCharacterIds: ['DANNY', 'DENIZ'], adultScene: true }, family);
  assert.equal(intimate.relationshipDisplayLabel, '');
  assert.equal(storyChoiceLabelForAction(intimate), 'Kesiti oynat · Deniz');
});

test('uncertain, unsupported and conflicting relationships stay out of choices', () => {
  for (const relationships of [
    [{ ...cast.relationships[0], confidence: NaN }],
    [{ ...cast.relationships[0], confidence: undefined }],
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

test('ordinary dialogue shows an evidenced relationship without exposing unnamed tracks', () => {
  const context = {
    characters: cast.characters.slice(0, 2).map(character => ({ ...character, displayName: '', evidence: '' })),
    relationships: [{ ...cast.relationships[0], relation: 'sevgilisi', evidence: 'Konuşmada sevgilisi olarak tanıtıyor.' }]
  };
  const action = bindActionCharacter({ label: 'Konuşmayı sürdür', subjectTrackId: 'MAIN_MALE',
    primaryCharacterId: 'MERAL', involvedCharacterIds: ['DANNY', 'MERAL'], adultScene: false }, context);
  assert.equal(action.primaryCharacterId, 'PARTNER_A');
  assert.equal(storyChoiceLabelForAction(action), 'Sevgilisi · Konuşmayı sürdür');
  const unknown = bindActionCharacter(action, { ...context, relationships: [] });
  assert.equal(storyChoiceLabelForAction(unknown), 'Konuşmayı sürdür');
});

test('repeated relationship evidence using track aliases does not erase an ordinary dialogue fact', () => {
  const action = { label: 'Cevabını dinle', subjectTrackId: 'MAIN_MALE', primaryCharacterId: 'MERAL' };
  const context = { ...cast, relationships: [cast.relationships[0],
    { ...cast.relationships[0], from: 'MAIN_MALE', to: 'PARTNER_A', confidence: 0.9 }] };
  assert.equal(bindActionCharacter(action, context).relationshipResolution, 'verified');
  const wrongPair = bindActionCharacter({ ...action, primaryCharacterId: 'DENIZ' }, context);
  assert.equal(wrongPair.relationshipDisplayLabel, '');
});

test('participant placeholders are hidden in ordinary choice copy and are never treated as names', () => {
  for (const primaryCharacterLabel of ['Karakter A', 'Karakter B', 'Ana karakter', 'kadın', 'erkek', 'Partner A']) {
    assert.equal(storyChoiceLabelForAction({ label: 'Cevabını dinle', primaryCharacterLabel, adultScene: false }), 'Cevabını dinle');
  }
  for (const displayName of ['sevgilisi', 'kız arkadaşı', 'girlfriend']) {
    assert.equal(verifiedCharacterName({ ...cast.characters[1], displayName }), '');
  }
});

test('an explicit addressed character is preserved in a group scene', () => {
  const action = bindActionCharacter({ label: 'Cevabını dinle', primaryCharacterId: 'DENIZ', involvedCharacterIds: ['DANNY', 'MERAL', 'DENIZ'] }, cast);
  assert.equal(action.primaryCharacterLabel, 'Deniz');
  assert.equal(action.primaryCharacterId, 'PARTNER_B');
});

test('four-person dialogue follows the actual speaker and target when the pair changes', () => {
  const context = { characters: [
    named('ALI', 'MAIN_MALE', 'Ali'), named('ECE', 'PARTNER_A', 'Ece'),
    named('BERK', 'PARTNER_B', 'Berk'), named('DERYA', 'PARTNER_C', 'Derya')
  ], relationships: [
    { from: 'ALI', to: 'ECE', relation: 'eşi', evidenceLevel: 'fact', confidence: .95, evidence: 'Ali, Ece’yi eşi olarak tanıtıyor.' },
    { from: 'BERK', to: 'DERYA', relation: 'eşi', evidenceLevel: 'fact', confidence: .95, evidence: 'Berk, Derya’yı eşi olarak tanıtıyor.' }
  ] };
  const action = { label: 'Soruyu sor', groupScene: true, adultScene: false,
    involvedCharacterIds: ['ALI', 'ECE', 'BERK', 'DERYA'] };
  const first = bindActionCharacter({ ...action, subjectTrackId: 'PARTNER_B', primaryCharacterId: 'DERYA', partnerTrackId: 'PARTNER_C' }, context);
  assert.equal(first.characterPairLabel, 'Berk → Derya');
  assert.equal(first.relationshipDisplayLabel, 'Berk ile ilişkisi: eşi');
  assert.equal(storyChoiceLabelForAction(first), "Berk'in eşi · Soruyu sor");
  const second = bindActionCharacter({ ...first, subjectTrackId: 'MAIN_MALE', primaryCharacterId: 'ECE', partnerTrackId: 'PARTNER_A' }, context);
  assert.equal(second.characterPairLabel, 'Ali → Ece');
  assert.equal(second.relationshipDisplayLabel, 'Ali ile ilişkisi: eşi');
  assert.doesNotMatch(storyChoiceLabelForAction(second), /Berk|Derya/);
});

test('a group with no identified speaker never defaults to the first actor or retains stale relationships', () => {
  const result = bindActionCharacter({ label: 'Konuşmayı sürdür', primaryCharacterId: 'MERAL',
    involvedCharacterIds: ['DANNY', 'MERAL', 'DENIZ'], groupScene: true,
    relationshipContext: 'Eski ilişki', relationshipDisplayLabel: 'Eski ilişki', characterPairLabel: 'Eski çift' }, cast);
  assert.equal(result.primaryCharacterLabel, 'Meral');
  assert.equal(result.relationshipDisplayLabel, '');
  assert.equal(result.relationshipContext, '');
  assert.equal(result.characterPairLabel, '');
});

test('a speaker absent from this action cannot contribute relationship copy', () => {
  const result = bindActionCharacter({ label: 'Soruyu dinle', subjectTrackId: 'MAIN_MALE',
    primaryCharacterId: 'MERAL', involvedCharacterIds: ['MERAL', 'DENIZ'] }, cast);
  assert.equal(result.primaryCharacterLabel, 'Meral');
  assert.equal(result.relationshipDisplayLabel, '');
});

test('conflicting primary and partner tracks do not produce two different names for one target', () => {
  const result = bindActionCharacter({ label: 'Soruyu dinle', primaryCharacterId: 'MERAL', partnerTrackId: 'PARTNER_B',
    involvedCharacterIds: ['DANNY', 'MERAL', 'DENIZ'] }, cast);
  assert.equal(result.identityResolution, 'conflict');
  assert.equal(result.primaryCharacterLabel, '');
  assert.equal(result.partnerLabel, '');
  assert.equal(result.characterPairLabel, '');
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
    assert.equal(bindActionCharacter({ label, partnerTrackId: 'PARTNER_A' }, cast).label, 'Eşi · Kesiti oynat');
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
  for (const action of analysis.actions) assert.equal(storyChoiceLabelForAction(action), 'Eşi · Cevabı dinle');
  const normalizedAgain = scope.normalizeAnalysis(JSON.parse(JSON.stringify(analysis)));
  for (const action of normalizedAgain.actions) assert.equal(storyChoiceLabelForAction(action), 'Eşi · Cevabı dinle');
});

test('a partial second-pass review cannot erase the first-pass character registry', () => {
  const action = { actionId: 'one', startTime: 10, endTime: 15, label: 'Cevabı dinle', primaryCharacterId: 'MERAL', sourceVerified: true };
  const merged = mergeSecondPassReview({ storyContext: cast, actions: [action] },
    { storyContext: {}, actions: [action] }, [action]);
  assert.equal(merged.storyContext.characters.length, 3);
  assert.equal(bindActionCharacter(merged.actions[0], merged.storyContext).primaryCharacterLabel, 'Meral');
});

const relationshipFact = (from, to, relation) => ({ from, to, relation, evidenceLevel: 'fact', confidence: .95,
  evidence: 'Diyalog bu iki kişi arasındaki ilişkiyi açıkça belirtiyor.' });
const familyCast = { characters: [named('MOTHER', 'person-1', 'Meral'), named('DAUGHTER', 'person-2', 'Ayşe'),
  named('GRANDFATHER', 'person-3', 'Kemal'), named('GRANDCHILD', 'person-4', 'Deniz')],
  relationships: [relationshipFact('MOTHER', 'DAUGHTER', 'kızı'), relationshipFact('DAUGHTER', 'MOTHER', 'annesi'),
    relationshipFact('GRANDFATHER', 'GRANDCHILD', 'torunu'), relationshipFact('GRANDCHILD', 'GRANDFATHER', 'dedesi')] };

test('mother/daughter and grandfather/grandchild choices use the target role in both directions', () => {
  for (const [subject, target, label, expected] of [
    ['MOTHER', 'DAUGHTER', 'Genç kadınla sohbet et', 'Kızıyla sohbet et'],
    ['DAUGHTER', 'MOTHER', 'Meral ile sohbet et', 'Annesiyle sohbet et'],
    ['GRANDFATHER', 'GRANDCHILD', 'Genç erkekle spor yap', 'Torunuyla spor yap'],
    ['GRANDCHILD', 'GRANDFATHER', 'Kemal ile spor yap', 'Dedesiyle spor yap']
  ]) {
    for (const actionLevel of ['main', 'bonus']) {
      const source = { actionId: 'observed-1', label, narrativeChoiceLabel: label, actionLevel,
        subjectTrackId: subject, primaryCharacterId: target, involvedCharacterIds: [subject, target],
        startTime: 30, endTime: 37, sourceVerified: true, sourceSegmentId: 'source-1' };
      const bound = bindActionCharacter(source, familyCast);
      assert.equal(storyChoiceLabelForAction(bound), expected);
      assert.equal(bound.label, expected);
      assert.equal(bound.narrativeChoiceLabel, expected);
      for (const key of ['actionId', 'actionLevel', 'startTime', 'endTime', 'sourceVerified', 'sourceSegmentId']) {
        assert.equal(bound[key], source[key]);
      }
      assert.equal(storyChoiceLabelForAction(bindActionCharacter(bound, familyCast)), expected);
    }
  }
});

test('verified reverse evidence is used only when it establishes an unambiguous target role', () => {
  const reverseOnly = { ...familyCast, relationships: [relationshipFact('GRANDCHILD', 'GRANDFATHER', 'grandfather')] };
  const action = { label: 'Onunla spor yap', subjectTrackId: 'GRANDFATHER', primaryCharacterId: 'GRANDCHILD',
    involvedCharacterIds: ['GRANDFATHER', 'GRANDCHILD'] };
  assert.equal(storyChoiceLabelForAction(bindActionCharacter(action, reverseOnly)), 'Torunuyla spor yap');
  const unsupportedReverse = { ...familyCast, relationships: [relationshipFact('GRANDFATHER', 'GRANDCHILD', 'torunu')] };
  assert.equal(bindActionCharacter({ ...action, subjectTrackId: 'GRANDCHILD', primaryCharacterId: 'GRANDFATHER' }, unsupportedReverse).relationshipResolution, 'unknown');
});

test('equivalent role aliases do not create a false conflict', () => {
  const context = { ...familyCast, relationships: [relationshipFact('MOTHER', 'DAUGHTER', 'kızı'),
    relationshipFact('person-1', 'person-2', 'daughter')] };
  const action = bindActionCharacter({ label: 'Onunla sohbet et', subjectTrackId: 'MOTHER', primaryCharacterId: 'DAUGHTER',
    involvedCharacterIds: ['MOTHER', 'DAUGHTER'] }, context);
  assert.equal(storyChoiceLabelForAction(action), 'Kızıyla sohbet et');
});

test('changing the speaker changes the same target from daughter to cousin without retaining a stale role', () => {
  const context = { ...familyCast, relationships: [...familyCast.relationships, relationshipFact('GRANDCHILD', 'DAUGHTER', 'kuzeni')] };
  const first = bindActionCharacter({ label: 'Onunla konuş', groupScene: true,
    subjectTrackId: 'MOTHER', primaryCharacterId: 'DAUGHTER',
    involvedCharacterIds: ['MOTHER', 'DAUGHTER', 'GRANDCHILD'] }, context);
  assert.equal(storyChoiceLabelForAction(first), "Meral'in kızıyla konuş");
  const second = bindActionCharacter({ ...first, subjectTrackId: 'GRANDCHILD' }, context);
  assert.equal(storyChoiceLabelForAction(second), "Deniz'in kuzeniyle konuş");
  const noEvidence = bindActionCharacter(second, { ...context, relationships: [] });
  assert.equal(noEvidence.label, "Ayşe'yle konuş");
  assert.doesNotMatch(storyChoiceLabelForAction(noEvidence), /kızı|kuzeni/);
});

test('verified social roles work without a proper name while unsupported relationships never become facts', () => {
  const unknownNames = { ...familyCast, characters: familyCast.characters.map(person => ({ ...person, displayName: '' })) };
  const action = { label: 'Onunla sohbet et', subjectTrackId: 'MOTHER', primaryCharacterId: 'DAUGHTER',
    involvedCharacterIds: ['MOTHER', 'DAUGHTER'] };
  for (const [relation, expected] of [['dostu', 'Dostuyla sohbet et'], ['arkadaşı', 'Arkadaşıyla sohbet et'],
    ['iş arkadaşı', 'İş arkadaşıyla sohbet et'], ['eşi', 'Eşiyle sohbet et'], ['akrabası', 'Akrabasıyla sohbet et']]) {
    assert.equal(storyChoiceLabelForAction(bindActionCharacter(action, { ...unknownNames,
      relationships: [relationshipFact('MOTHER', 'DAUGHTER', relation)] })), expected);
  }
  const uncertain = bindActionCharacter(action, { ...familyCast,
    relationships: [{ ...familyCast.relationships[0], evidenceLevel: 'inference' }] });
  assert.equal(uncertain.relationshipResolution, 'unknown');
  assert.equal(uncertain.label, "Ayşe'yle sohbet et");
});

test('non-story position metadata prevents an ordinary relationship label even when the scene flag is missing', () => {
  const action = bindActionCharacter({ label: 'Kesiti oynat', subjectTrackId: 'MOTHER', primaryCharacterId: 'DAUGHTER',
    involvedCharacterIds: ['MOTHER', 'DAUGHTER'], positionId: 'position-1' }, familyCast);
  assert.equal(action.relationshipResolution, 'unknown');
  assert.equal(storyChoiceLabelForAction(action), 'Kesiti oynat · Ayşe');
});

test('verified spouse and partner roles reach adult movement cards while family roles remain neutral context', () => {
  const spouse = bindActionCharacter({ label: 'Onunla ritmi sürdür', subjectTrackId: 'MAIN_MALE',
    primaryCharacterId: 'MERAL', involvedCharacterIds: ['DANNY', 'MERAL'], adultScene: true,
    positionId: 'position-1' }, cast);
  assert.equal(spouse.relationshipRoleLabel, 'eşi');
  assert.equal(storyChoiceLabelForAction(spouse), 'Eşiyle ritmi sürdür');

  const family = { ...cast, relationships: [relationshipFact('DANNY', 'DENIZ', 'kızı')] };
  const familyAction = bindActionCharacter({ label: 'Kesiti oynat', subjectTrackId: 'MAIN_MALE',
    primaryCharacterId: 'DENIZ', involvedCharacterIds: ['DANNY', 'DENIZ'], adultScene: true,
    positionId: 'position-2' }, family);
  assert.equal(familyAction.relationshipResolution, 'unknown');
  assert.equal(storyChoiceLabelForAction(familyAction), 'Kesiti oynat · Deniz');
});

test('ordinary protagonist choices recover an omitted subject track and keep the verified family role', () => {
  const context = { characters: [named('GRANDFATHER', 'MAIN_MALE', 'Kemal'), named('GRANDCHILD', 'person-2', 'Deniz')],
    relationships: [relationshipFact('GRANDFATHER', 'GRANDCHILD', 'torunu')] };
  const action = bindActionCharacter({ label: 'Genç oğlan ile konuş', primaryCharacterId: 'GRANDCHILD',
    involvedCharacterIds: ['GRANDCHILD'], adultScene: false }, context);
  assert.equal(action.relationshipSubjectId, 'MAIN_MALE');
  assert.equal(action.relationshipTargetId, 'person-2');
  assert.equal(storyChoiceLabelForAction(action), 'Torunuyla konuş');
});

test('ordinary mother choices recover the same relation in main and bonus options without generic gender copy', () => {
  const context = { characters: [named('MOTHER', 'MAIN_MALE', 'Meral'), named('DAUGHTER', 'person-2', 'Ayşe')],
    relationships: [relationshipFact('MOTHER', 'DAUGHTER', 'kızı')] };
  for (const actionLevel of ['main', 'bonus']) {
    const action = bindActionCharacter({ label: 'Genç kadınla konuş', primaryCharacterId: 'DAUGHTER',
      involvedCharacterIds: ['DAUGHTER'], actionLevel, adultScene: false }, context);
    assert.equal(storyChoiceLabelForAction(action), 'Kızıyla konuş');
  }
});
