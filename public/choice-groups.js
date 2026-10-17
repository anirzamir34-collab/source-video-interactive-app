import { clipRange } from './sequence-integrity.js';
import { choiceSurfaceKey } from './choice-routing.js';
import { cleanDisplayLabel } from './display-labels.js';

const text = value => String(value || '').trim();
export const sourceActionLabel = value => text(value)
  .replace(/\s*·\s*(?:Sekans|Bölüm)\s+\d+$/iu, '').trim();

// Display text is provider data. Keep it opaque and use the caller's existing
// fallback when no verified display label was supplied.
export function sourceDisplayLabel(group = {}, fallback = '', {
  partnerLabel = group.partnerLabel,
  distinguishPartner = false
} = {}) {
  const label = group.sourceVerified === true && text(group.positionLabel)
    ? text(group.positionLabel) : text(fallback);
  const suppliedPartner = text(partnerLabel);
  // Provider tracking aliases are not character names. Never append them to
  // any verified source category label, regardless of the video genre.
  const internalTrack = /^(?:karakter|character|partner|person|participant|kişi)[\s_-]+(?:[a-z]\d*|\d+)(?:[\s/]+(?:[a-z]\d*|\d+))*$/iu;
  const partner = internalTrack.test(suppliedPartner) ? '' : suppliedPartner;
  return label && distinguishPartner === true && partner &&
    label !== partner && !label.endsWith(` · ${partner}`)
    ? `${label} · ${partner}` : label;
}

// Display never exposes stable internal track aliases. A track ID can be
// useful for routing without constituting a verified, visible person's name.
export function sourceIdentityLabel(value, clip = {}) {
  const label = cleanDisplayLabel(sourceActionLabel(value));
  if (!label || clip?.relationshipResolution === 'verified') return label;
  const identity = ['verified', 'described'].includes(clip?.identityResolution)
    ? text(clip.primaryCharacterLabel) : '';
  if (!identity ||
      /^(?:karakter|ana karakter|partner|kadın|erkek|adam|kişi)(?:\s+\S+)?$/iu.test(identity) ||
      label.toLocaleLowerCase('tr-TR').includes(identity.toLocaleLowerCase('tr-TR'))) return label;
  return cleanDisplayLabel(`${label} · ${identity}`);
}

// Arrange existing clips only. These groups never join media ranges, create
// actions, change playback rate or make uncertain clips selectable.
export function groupSourceChoiceCards(clips, {
  preferredCount = 5,
  contextFor,
  bandFor,
  labelFor,
  mergeWithinContext = false,
  mergeEquivalentMotionTypes = false
} = {}) {
  // Deduplicate only identical source records. The same title at different
  // verified timestamps is not a duplicate and must retain its own playback
  // route. Never manufacture extra options from a single recorded interval.
  const exactRecords = new Set();
  const source = (Array.isArray(clips) ? clips : [])
    .filter(clip => {
      const range = clipRange(clip);
      if (clip?.sourceVerified !== true || !clip.id || !range) return false;
      const identity = JSON.stringify([
        String(clip.id), String(clip.sourcePositionId || clip.sourceGroupId || ''),
        String(clip.sourceOccurrenceId || clip.positionOccurrenceId || clip.occurrenceId || ''),
        range.startTime, range.endTime,
        choiceSurfaceKey(clip), text(clip.adultSceneId), text(clip.routeNamespace),
        text(clip.subjectTrackId), text(clip.partnerTrackId), text(clip.primaryCharacterId),
        [...new Set([...(clip.participantTrackIds || []), ...(clip.involvedCharacterIds || [])].map(text))].sort(),
        text(clip.actionType), text(clip.movementType),
        text(clip.sourceActionId || clip.observedActionId || clip.actionOriginId || clip.derivedFromVerifiedSegment),
        clip.startTime ?? null, clip.endTime ?? null
      ]);
      if (exactRecords.has(identity)) return false;
      exactRecords.add(identity);
      return true;
    })
    .sort((a, b) => clipRange(a).startTime - clipRange(b).startTime || String(a.id).localeCompare(String(b.id)));
  // A display target must not manufacture numbered copies of one observation
  // or compress different observations merely to reach a card count.
  void preferredCount;
  const groups = [];
  for (const clip of source) {
    const label = sourceActionLabel(labelFor?.(clip) || clip.label);
    const rawProfile = bandFor?.(clip) || text(clip.movementTempo) || 'unclear';
    const profile = rawProfile && typeof rawProfile === 'object'
      ? rawProfile
      : { key: text(rawProfile) || 'unclear', intensityBand: text(rawProfile) || 'unclear' };
    const band = text(profile.key) || 'unclear';
    const occurrence = text(contextFor?.(clip));
    const declaredScope = [text(clip.adultSceneId), text(clip.sourcePositionId || clip.sourceGroupId),
      text(clip.sourceOccurrenceId || clip.positionOccurrenceId || clip.occurrenceId)];
    const hasScope = Boolean(occurrence || declaredScope.some(Boolean));
    const actionType = [text(clip.actionType), text(clip.movementType)];
    const hasType = actionType.some(Boolean);
    const declaredOrigin = text(clip.sourceActionId || clip.observedActionId ||
      clip.actionOriginId || clip.derivedFromVerifiedSegment);
    const stableContext = mergeWithinContext && occurrence;
    // Different model IDs can be cuts of one observed action, but only when
    // their visible description also agrees. Tempo alone is not an identity.
    const sameObservedAction = stableContext &&
      ['position', 'movement', 'tempo_change', 'rhythm'].includes(text(clip.actionType).toLowerCase()) &&
      Boolean(label);
    const motionKind = text(clip.actionType).toLowerCase();
    const actionKind = mergeEquivalentMotionTypes && text(clip.movementType) &&
      ['position', 'tempo_change', 'movement', 'rhythm'].includes(motionKind)
      ? ['verified-motion', text(clip.movementType)] : actionType;
    const key = JSON.stringify([
      choiceSurfaceKey(clip),
      occurrence || declaredScope,
      stableContext ? '' : text(clip.partnerTrackId),
      stableContext ? '' : text(clip.subjectTrackId),
      stableContext ? '' : text(clip.primaryCharacterId),
      stableContext ? [] : [...(clip.participantTrackIds || [])].map(text).sort(),
      stableContext ? '' : text(clip.receiverBodyOrientation),
      stableContext ? '' : text(clip.receiverSupport), band,
      // Even a trusted display context cannot erase the provider's declared
      // action kind or the origin of parts split from one observed action.
      hasScope && hasType ? [actionKind, label.toLocaleLowerCase('tr-TR')] : label,
      sameObservedAction ? '' : declaredOrigin,
      hasScope ? '' : text(clip.derivedFromVerifiedSegment || clip.id)
    ]);
    const previous = groups.at(-1);
    const priorRange = previous ? clipRange(previous.clips.at(-1)) : null;
    const range = clipRange(clip);
    // Never let an option jump over another event or an unverified gap.
    const adjacent = priorRange && range.startTime >= priorRange.endTime - 0.05 &&
      range.startTime <= priorRange.endTime + 1;
    if (previous?.key === key && adjacent) previous.clips.push(clip);
    else groups.push({ key, band, profile, occurrence, clips: [clip] });
  }
  const cards = [];
  for (const group of groups) {
    const first = group.clips[0];
    const range = clipRange(first);
    cards.push({
      id: `movement-choice:${encodeURIComponent(JSON.stringify([group.key, first.id, range.startTime]))}`,
      label: sourceActionLabel(labelFor?.(first) || first.label) || 'Kesiti oynat',
      tempo: group.profile.tempo || (group.profile.intensityBand === 'slow' ? 'slow'
        : group.profile.intensityBand === 'intense' ? 'fast' : 'moderate'),
      intensityBand: group.profile.intensityBand || group.band,
      energyFlavor: group.profile.energyFlavor || group.profile.intensityBand || group.band,
      energyLabel: group.profile.energyLabel || '',
      hasTempoShift: false, tempoVariants: [],
      sourcePositionId: text(first.sourcePositionId), occurrenceId: group.occurrence,
      variants: group.clips
    });
  }
  return cards.sort((a, b) => clipRange(a.variants[0]).startTime - clipRange(b.variants[0]).startTime)
    .map((card, index) => ({ ...card, displayIndex: index + 1 }));
}


/**
 * Presentation-only grouping: neighbouring source cuts that have exactly the
 * same observable action, participant, occurrence and tempo should not appear
 * as many indistinguishable buttons. Every verified cut remains a selectable
 * variant, with its exact source timestamps. No source ranges are enlarged.
 */
export function collapseConsecutiveEquivalentCards(cards = [], { maxGapSeconds = 0.3 } = {}) {
  const items = Array.isArray(cards) ? cards : [];
  const maxGap = Math.max(0, Math.min(0.5, Number(maxGapSeconds) || 0));
  const clean = value => text(value).toLocaleLowerCase('tr-TR').replace(/\s+/g, ' ');
  const identity = card => {
    const variants = Array.isArray(card?.variants) ? card.variants : [];
    const first = variants[0];
    if (!first || !variants.length || first.sourceVerified !== true ||
        !text(card.sourcePositionId) || !text(card.occurrenceId)) return null;
    return JSON.stringify([
      clean(card.label), clean(card.energyFlavor), clean(card.intensityBand),
      clean(card.tempo), text(card.sourcePositionId), text(card.occurrenceId),
      text(first.sourcePositionId), text(first.sourceOccurrenceId || first.positionOccurrenceId || first.occurrenceId),
      text(first.subjectTrackId), text(first.partnerTrackId),
      text(first.actionType), clean(first.movementType), clean(first.movementTempo),
      text(first.routeNamespace)
    ]);
  };
  const grouped = [];
  for (const card of items) {
    const first = card?.variants?.[0];
    const current = identity(card);
    const previous = grouped.at(-1);
    const prior = previous?.variants?.at(-1);
    const priorIdentity = identity(previous);
    const a = prior ? clipRange(prior) : null;
    const b = first ? clipRange(first) : null;
    const gap = a && b ? b.startTime - a.endTime : Infinity;
    if (current && current === priorIdentity && a && b &&
        gap >= -0.05 && gap <= maxGap + 1e-6) {
      previous.variants.push(...card.variants);
      continue;
    }
    grouped.push({ ...card, variants: [...(card?.variants || [])] });
  }
  return grouped.map((card, index) => ({ ...card, displayIndex: index + 1 }));
}

// Presentation only: several adjacent, independently verified actions in one
// occurrence may live under one card. Every original source clip and its own
// label remain available as a variant; never bridge a gap or another group.
export function bundleAdjacentSourceCards(cards = [], { targetCount = 4, maxVariants = 6 } = {}) {
  const result = (Array.isArray(cards) ? cards : []).map(card => ({
    ...card, variants: [...(card?.variants || [])],
    sourceLabels: [...(card?.sourceLabels || [card?.label].filter(Boolean))]
  }));
  const target = Math.max(1, Math.min(8, Math.floor(Number(targetCount) || 4)));
  const capacity = Math.max(2, Math.min(12, Math.floor(Number(maxVariants) || 6)));
  const compatible = (left, right) => {
    const a = left?.variants?.at(-1), b = right?.variants?.[0];
    const last = a ? clipRange(a) : null, first = b ? clipRange(b) : null;
    if (!last || !first || a.sourceVerified !== true || b.sourceVerified !== true ||
        left.variants.length + right.variants.length > capacity ||
        !text(left.sourcePositionId) || left.sourcePositionId !== right.sourcePositionId ||
        text(left.occurrenceId) !== text(right.occurrenceId) ||
        text(left.intensityBand) !== text(right.intensityBand) ||
        text(left.energyFlavor) !== text(right.energyFlavor) ||
        text(left.tempo) !== text(right.tempo) ||
        sourceActionLabel(left.label).toLocaleLowerCase('tr-TR') !==
          sourceActionLabel(right.label).toLocaleLowerCase('tr-TR')) return false;
    for (const field of ['sourceOccurrenceId', 'positionOccurrenceId', 'routeNamespace',
      'subjectTrackId', 'partnerTrackId']) {
      if (text(a[field]) !== text(b[field])) return false;
    }
    return choiceSurfaceKey(a) === choiceSurfaceKey(b) &&
      first.startTime >= last.endTime - 0.05 && first.startTime <= last.endTime + 1;
  };
  while (result.length > target) {
    let pair = -1, smallest = Infinity;
    for (let index = 0; index < result.length - 1; index += 1) {
      if (!compatible(result[index], result[index + 1])) continue;
      const combined = result[index].variants.length + result[index + 1].variants.length;
      if (combined < smallest) { smallest = combined; pair = index; }
    }
    if (pair < 0) break;
    const left = result[pair], right = result[pair + 1];
    const labels = [...new Set([...left.sourceLabels, ...right.sourceLabels].map(text).filter(Boolean))];
    const sameEnergy = left.energyFlavor === right.energyFlavor;
    result.splice(pair, 2, {
      ...left,
      variants: [...left.variants, ...right.variants], sourceLabels: labels,
      label: labels.length <= 2 ? labels.join(' / ') : `${labels.slice(0, 2).join(' / ')} (+${labels.length - 2})`,
      energyFlavor: sameEnergy ? left.energyFlavor : 'mixed',
      energyLabel: sameEnergy ? left.energyLabel : '',
      hasTempoShift: false, tempoVariants: []
    });
  }
  return result.map((card, index) => ({ ...card, displayIndex: index + 1 }));
}

const visualState = value => typeof value === 'string' ? value.trim() :
  value && typeof value === 'object' ? JSON.stringify(value) : '';
const approachStage = clip => JSON.stringify([
  text(clip.locationId), text(clip.sceneId),
  visualState(clip.beforeState?.clothingState || clip.beforeState?.clothing ||
    clip.beforeState?.outfit)
]);
const sceneBarrier = clip => ['scene_transition', 'camera_transition', 'body_transition',
  'partner_transition'].includes(text(clip?.actionType).toLowerCase());

// A source stage changes only on declared visual state. The same stage stays
// replayable after its timeline has passed; an earlier room or outfit does not.
export function approachStageChoices(clips = [], cursor = 0) {
  const ordered = [...clips].sort((a, b) => Number(a.startTime) - Number(b.startTime));
  const current = [...ordered].reverse().find(item => Number(item.startTime) <= Number(cursor) + 0.05) || ordered[0];
  if (!current) return [];
  const stage = approachStage(current);
  const index = ordered.indexOf(current);
  let first = index, last = index;
  while (first > 0 && !sceneBarrier(ordered[first]) && !sceneBarrier(ordered[first - 1]) &&
      approachStage(ordered[first - 1]) === stage &&
      Number(ordered[first].startTime) - Number(ordered[first - 1].endTime) <= 45) first -= 1;
  while (last + 1 < ordered.length && !sceneBarrier(ordered[last]) &&
      !sceneBarrier(ordered[last + 1]) && approachStage(ordered[last + 1]) === stage &&
      Number(ordered[last + 1].startTime) - Number(ordered[last].endTime) <= 45) last += 1;
  const stageChoices = ordered.slice(first, last + 1);
  const prior = ordered[last], next = ordered[last + 1];
  // A body motion can end a replay stage without making the immediately
  // following verified motion disappear from the decision. Preview only the
  // forward clip: once playback reaches it, the old stage remains retired.
  if (next && text(prior.actionType).toLowerCase() === 'body_transition' &&
      prior.sourceVerified === true && next.sourceVerified === true &&
      choiceSurfaceKey(prior) === 'approach' && choiceSurfaceKey(next) === 'approach' &&
      text(prior.sceneId) && text(prior.sceneId) === text(next.sceneId) &&
      approachStage(prior) === approachStage(next) &&
      text(prior.subjectTrackId) && text(prior.subjectTrackId) === text(next.subjectTrackId) &&
      text(prior.partnerTrackId) && text(prior.partnerTrackId) === text(next.partnerTrackId) &&
      !['clothing', 'scene_transition', 'partner_transition'].includes(text(next.actionType).toLowerCase()) &&
      Number(next.startTime) >= Number(prior.endTime) - 0.05 &&
      Number(next.startTime) <= Number(prior.endTime) + 0.25) {
    stageChoices.push(next);
  }
  return stageChoices;
}

export function groupVerifiedApproachChoices(clips = []) {
  const cards = [];
  for (const clip of clips) {
    const range = clipRange(clip);
    if (clip?.sourceVerified !== true || !clip.id || !range) continue;
    const previous = cards.at(-1);
    const priorClip = previous?.variants.at(-1);
    const firstClip = previous?.variants[0];
    const priorRange = clipRange(priorClip);
    const closeRate = field => Math.abs(Number(firstClip?.[field] || 1) -
      Number(clip[field] || 1)) <= 0.2;
    const sameAction = priorClip && clip.nonIntimate !== true && priorClip.nonIntimate !== true &&
      choiceSurfaceKey(clip) !== 'story' && choiceSurfaceKey(priorClip) !== 'story' &&
      sourceActionLabel(previous.label).toLocaleLowerCase('tr-TR') ===
        sourceActionLabel(clip.label).toLocaleLowerCase('tr-TR') &&
      text(priorClip.actionType) === text(clip.actionType) &&
      text(priorClip.movementType) === text(clip.movementType) &&
      text(priorClip.movementTempo) === text(clip.movementTempo) &&
      text(priorClip.audioIntensity) === text(clip.audioIntensity) &&
      closeRate('femaleProgressRate') && closeRate('maleProgressRate') &&
      text(priorClip.routeNamespace) === text(clip.routeNamespace) &&
      text(priorClip.subjectTrackId) === text(clip.subjectTrackId) &&
      text(priorClip.partnerTrackId) === text(clip.partnerTrackId) &&
      approachStage(priorClip) === approachStage(clip) &&
      priorRange && range.startTime >= priorRange.endTime - 0.05 &&
      range.startTime <= priorRange.endTime + 1;
    if (sameAction) {
      previous.variants.push(clip);
      previous.endTime = range.endTime;
    } else cards.push({ ...clip, variants: [clip], startTime: range.startTime, endTime: range.endTime });
  }
  return cards;
}
