import { mergeCharacterRecords } from './character-identity.js';
import { relationshipChoiceLabel, verifiedRoleNoun } from './character-reference.js';
import { isOrdinaryRelationshipAction } from './relationship-roles.js';

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, Number(value) || 0));

const FACT_LEVELS = new Set(['fact', 'inference', 'unknown']);

function cleanText(value, max = 320) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function uniqueByText(items = [], max = 24) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(items) ? items : []) {
    const text = cleanText(raw?.text ?? raw?.label ?? raw, 420);
    if (!text) continue;
    const key = text.toLocaleLowerCase('tr-TR');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(typeof raw === 'object' && raw !== null ? { ...raw, text } : { text });
    if (out.length >= max) break;
  }
  return out;
}

export function normalizeEvidenceLevel(value) {
  const level = cleanText(value, 24).toLowerCase();
  return FACT_LEVELS.has(level) ? level : 'unknown';
}

export function normalizeStoryContext(input = {}) {
  const context = input && typeof input === 'object' ? input : {};
  const relationships = (Array.isArray(context.relationships) ? context.relationships : [])
    .slice(0, 16)
    .map(item => ({
      from: cleanText(item?.from, 80),
      to: cleanText(item?.to, 80),
      relation: cleanText(item?.relation, 100),
      evidenceLevel: normalizeEvidenceLevel(item?.evidenceLevel),
      confidence: clamp(item?.confidence),
      evidence: cleanText(item?.evidence, 360)
    }))
    .filter(item => item.from && item.to && item.relation);

  const characters = (Array.isArray(context.characters) ? context.characters : [])
    .slice(0, 16)
    .map(item => ({
      id: cleanText(item?.id, 80),
      participantTrackId: cleanText(item?.participantTrackId ?? item?.id, 80),
      ...(Array.isArray(item?.speakerIds) && item.speakerIds.length && cleanText(item?.voiceMatchEvidence)
        ? { speakerIds: [...new Set(item.speakerIds.map(id => cleanText(id, 80)).filter(Boolean))].slice(0, 8),
          voiceMatchEvidence: cleanText(item.voiceMatchEvidence, 360) } : {}),
      ...(item?.identityConflict === true ? { identityConflict: true } : {}),
      ...(Array.isArray(item?.characterIds) && item.characterIds.length
        ? { characterIds: [...new Set(item.characterIds.map(id => cleanText(id, 80)).filter(Boolean))].slice(0, 24) } : {}),
      displayName: cleanText(item?.displayName ?? item?.name, 100),
      sourceRole: cleanText(item?.sourceRole ?? item?.role, 100),
      role: cleanText(item?.role ?? item?.sourceRole, 100),
      description: cleanText(item?.description, 280),
      evidenceLevel: normalizeEvidenceLevel(item?.evidenceLevel),
      confidence: clamp(item?.confidence),
      evidence: cleanText(item?.evidence, 360)
    }))
    .filter(item => item.id || item.participantTrackId || item.displayName || item.sourceRole || item.description);

  return {
    synopsisTr: cleanText(context.synopsisTr, 900),
    currentSceneTitle: cleanText(context.currentSceneTitle, 140),
    currentSceneGoal: cleanText(context.currentSceneGoal, 320),
    setting: cleanText(context.setting, 180),
    emotionalTone: cleanText(context.emotionalTone, 140),
    characters,
    relationships,
    facts: uniqueByText(context.facts, 24).map(item => ({
      text: item.text,
      confidence: clamp(item.confidence ?? 1),
      evidence: cleanText(item.evidence, 360)
    })),
    inferences: uniqueByText(context.inferences, 24).map(item => ({
      text: item.text,
      confidence: clamp(item.confidence),
      evidence: cleanText(item.evidence, 360)
    })),
    unknowns: uniqueByText(context.unknowns, 24).map(item => item.text)
  };
}

export function mergeStoryContexts(results = []) {
  const contexts = (Array.isArray(results) ? results : [])
    .map(result => normalizeStoryContext(result?.storyContext || result))
    .filter(context => context.synopsisTr || context.currentSceneTitle || context.facts.length || context.inferences.length ||
      context.characters.length || context.relationships.length || context.unknowns.length);

  if (!contexts.length) return normalizeStoryContext({});

  const latestText = key => contexts.reduce((value, context) => context[key] || value, '');
  const facts = uniqueByText(contexts.flatMap(context => context.facts), 40)
    .map(item => ({ text: item.text, confidence: clamp(item.confidence ?? 1), evidence: cleanText(item.evidence, 360) }));
  const inferences = uniqueByText(contexts.flatMap(context => context.inferences), 40)
    .map(item => ({ text: item.text, confidence: clamp(item.confidence), evidence: cleanText(item.evidence, 360) }));
  const unknowns = [...new Set(contexts.flatMap(context => context.unknowns).map(item => cleanText(item, 260)).filter(Boolean))].slice(0, 30);

  const relationships = [];
  const relationshipKeys = new Set();
  for (const context of contexts) {
    for (const relationship of context.relationships) {
      const key = `${relationship.from}|${relationship.to}|${relationship.relation}`.toLocaleLowerCase('tr-TR');
      const existingIndex = relationships.findIndex(item => `${item.from}|${item.to}|${item.relation}`.toLocaleLowerCase('tr-TR') === key);
      if (existingIndex >= 0) {
        if (relationship.confidence > relationships[existingIndex].confidence) relationships[existingIndex] = relationship;
      } else if (!relationshipKeys.has(key)) {
        relationshipKeys.add(key);
        relationships.push(relationship);
      }
    }
  }

  const characters = mergeCharacterRecords(contexts.flatMap(context => context.characters));

  const synopsisParts = contexts.map(context => context.synopsisTr).filter(Boolean);
  return normalizeStoryContext({
    synopsisTr: synopsisParts.slice(-4).join(' '),
    currentSceneTitle: latestText('currentSceneTitle'),
    currentSceneGoal: latestText('currentSceneGoal'),
    setting: latestText('setting'),
    emotionalTone: latestText('emotionalTone'),
    characters,
    relationships,
    facts,
    inferences,
    unknowns
  });
}

export function storyChoiceLabelForAction(action = {}) {
  const fallback = cleanText(action.label, 180) || 'Devam et';
  const narrative = cleanText(action.narrativeChoiceLabel, 180);
  const withCharacter = label => {
    if (action.relationshipResolution === 'verified' &&
        action.relationshipSubjectId && action.relationshipTargetId &&
        verifiedRoleNoun(action.relationshipRoleLabel)) {
      return relationshipChoiceLabel(label, action.relationshipRoleLabel, action.relationshipOwnerLabel);
    }
    let character = cleanText(action.primaryCharacterLabel, 100);
    if (action.adultScene !== true && action.characterPairResolution === 'verified') {
      character = cleanText(action.characterPairLabel, 160) || character;
    }
    // Participant IDs are internal tracking data, not story copy. Keep the
    // verified relationship below when a proper name is not yet established.
    if (/^(?:karakter(?:\s+\S+)?|ana karakter|partner(?:\s+\S+)?|kadın|erkek|adam|kişi)$/iu.test(character)) {
      character = '';
    }
    if (action.adultScene === true && /\b(?:anne|baba|kardeş|abla|ağabey|abi|amca|dayı|hala|teyze|üvey)\b/i.test(character)) {
      const partner = cleanText(action.partnerLabel, 100);
      character = partner && !/\b(?:anne|baba|kardeş|abla|ağabey|abi|amca|dayı|hala|teyze|üvey)\b/i.test(partner)
        ? partner : '';
    }
    const relationship = action.adultScene === true ? '' : cleanText(action.relationshipDisplayLabel, 140);
    const withRelationship = value => relationship && !value.toLocaleLowerCase('tr-TR').includes(relationship.toLocaleLowerCase('tr-TR'))
      ? `${value} · ${relationship}` : value;
    if (!character) return withRelationship(label);
    const normalizedLabel = label.toLocaleLowerCase('tr-TR');
    if (normalizedLabel.includes(character.toLocaleLowerCase('tr-TR'))) return withRelationship(label);
    return withRelationship(`${label} · ${character}`);
  };
  if (!narrative) return withCharacter(fallback);

  const level = normalizeEvidenceLevel(action.storyEvidenceLevel);
  const confidence = clamp(action.storyConfidence);
  const evidence = cleanText(action.storyEvidence, 360);

  if (level === 'fact' && confidence >= 0.68 && evidence) return withCharacter(narrative);
  if (level === 'inference' && confidence >= 0.88 && evidence) return withCharacter(narrative);
  return withCharacter(fallback);
}

function normalizeChoiceIntentText(value) {
  return String(value || '')
    .toLocaleLowerCase('tr-TR')
    .replace(/[ıİ]/g, 'i')
    .replace(/ş/g, 's').replace(/ç/g, 'c').replace(/ğ/g, 'g')
    .replace(/ü/g, 'u').replace(/ö/g, 'o')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function storyChoiceIntentKey(action = {}) {
  const text = normalizeChoiceIntentText(storyChoiceLabelForAction(action));
  const intentPatterns = [
    ['observe', /\b(bak|izle|seyret|suz|gozlem|incele)\b/],
    ['approach', /\b(yaklas|yanina git|yanina ilerle|ileri git)\b/],
    ['talk', /\b(konus|sohbet|sor|cevap ver|seslen|soyle)\b/],
    ['leave', /\b(uzaklas|ayril|geri cekil|oradan git|disari cik)\b/],
    ['follow', /\b(takip et|pesinden git)\b/],
    ['touch', /\b(dokun|oksa|tut|saril|elini uzat)\b/],
    ['take', /\b(al|kaldir|cebine koy)\b/],
    ['open', /\b(ac|kilidi ac)\b/],
    ['enter', /\b(gir|iceri gir)\b/]
  ];
  const intent = intentPatterns.find(([, pattern]) => pattern.test(text))?.[0];
  if (intent) return intent;
  const tokens = text.split(' ').filter(token =>
    token.length > 2 && !['kizi', 'kadini', 'kadinla', 'kadin', 'erkegi', 'erkek', 'biraz', 'devam'].includes(token)
  );
  return tokens.slice(0, 3).join('-') || text;
}

export function selectDiverseStoryActions(actions = [], limit = 3) {
  const maximum = Math.max(1, Math.min(4, Math.floor(Number(limit) || 3)));
  const selected = [];
  const intents = new Set();
  for (const action of Array.isArray(actions) ? actions : []) {
    const intent = storyChoiceIntentKey(action);
    if (!intent || intents.has(intent)) continue;
    intents.add(intent);
    selected.push(action);
    if (selected.length >= maximum) break;
  }
  return selected;
}

export function storyActionMeta(action = {}) {
  return {
    sceneTitle: cleanText(action.sceneTitle, 140),
    sceneGoal: cleanText(action.sceneGoal, 280),
    relationshipContext: cleanText(action.relationshipContext, 200),
    narrativeReason: cleanText(action.narrativeReason, 280),
    storyEvidenceLevel: normalizeEvidenceLevel(action.storyEvidenceLevel),
    storyConfidence: clamp(action.storyConfidence),
    storyEvidence: cleanText(action.storyEvidence, 360)
  };
}

export function sensoryActionMeta(action = {}) {
  const confidence = clamp(action.sensoryConfidence);
  const evidence = cleanText(action.sensoryEvidence, 360);
  if (confidence < 0.55 || !evidence) return { cues: [], confidence, evidence };

  const cues = [];
  const audioLevel = { low: 'Hafif', moderate: 'Belirgin', high: 'Yoğun' };
  const audioType = { breathing: 'nefes', moan: 'inleme', laughter: 'gülüş', crying: 'ağlama', vocal_reaction: 'ses tepkisi', mixed: 'karışık ses tepkisi' };
  const gaze = { brief: 'Kısa bakış', sustained: 'Uzun bakış', mutual: 'Karşılıklı yoğun bakış' };
  const affect = { relaxed: 'Rahat görünüm', tense: 'Gergin görünüm', happy: 'Mutlu görünüm', sad: 'Üzgün görünüm', fearful: 'Korkulu görünüm', excited: 'Heyecanlı görünüm', distressed: 'Rahatsızlık işaretleri' };
  const body = { relaxed: 'Rahat beden tepkisi', tense: 'Bedensel gerilim', recoil: 'Geri çekilme', rhythmic: 'Ritmik tepki', changing: 'Değişen beden tepkisi' };

  if (audioLevel[action.audioIntensity] && audioType[action.nonSpeechAudio]) {
    cues.push(`${audioLevel[action.audioIntensity]} ${audioType[action.nonSpeechAudio]}`);
  } else if (audioLevel[action.audioIntensity]) {
    cues.push(`${audioLevel[action.audioIntensity]} ses tepkisi`);
  }
  if (gaze[action.gazeIntensity]) cues.push(gaze[action.gazeIntensity]);
  if (affect[action.observedAffect]) cues.push(affect[action.observedAffect]);
  if (body[action.bodyResponse]) cues.push(body[action.bodyResponse]);
  return { cues: [...new Set(cues)].slice(0, 3), confidence, evidence };
}
