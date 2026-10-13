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
  mergeWithinContext = false
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
  const requestedTarget = Math.max(1, Math.min(8, Math.floor(Number(preferredCount) || 5)));
  // This is a density preference, never a hard cap that combines unrelated
  // source actions. Small rich inputs should still expose several choices.
  // A position with several verified source clips should expose more than one
  // or two cards; grouping still keeps adjacent variants from the same
  // observed action together and never synthesizes a new clip.
  const target = Math.min(requestedTarget, mergeWithinContext
    ? source.length : Math.max(1, Math.ceil(source.length / 3)));
  const groups = new Map();
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
    // A verified temporal rhythm is the logical gameplay option within the
    // same source occurrence. Different model action IDs are its clip variants,
    // not separate one-clip buttons. Unknown rhythms retain distinct origins.
    const sameObservedRhythm = stableContext &&
      ['position', 'movement', 'tempo_change', 'rhythm'].includes(text(clip.actionType).toLowerCase()) &&
      ['slow', 'fast', 'intense', 'deep', 'hard'].includes(text(profile.energyFlavor).toLowerCase()) &&
      ['slow', 'moderate', 'fast'].includes(text(clip.movementTempo).toLowerCase());
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
      sameObservedRhythm ? '' : (hasScope && hasType ? actionType : label),
      sameObservedRhythm ? '' : declaredOrigin,
      hasScope ? '' : text(clip.derivedFromVerifiedSegment || clip.id)
    ]);
    if (!groups.has(key)) groups.set(key, { key, band, profile, occurrence,
      semanticRhythm: Boolean(sameObservedRhythm), packets: new Map() });
    const group = groups.get(key);
    const origin = declaredOrigin || text(clip.id);
    if (!group.packets.has(origin)) group.packets.set(origin, []);
    group.packets.get(origin).push(clip);
  }
  const cards = [];
  for (const group of groups.values()) {
    const groupSize = [...group.packets.values()].reduce((sum, packet) => sum + packet.length, 0);
    const proportionalCards = Math.max(1, Math.round(target * groupSize / Math.max(1, source.length)));
    // A semantic option plays up to five verified source cuts in order. Beyond
    // that, separate bounded cards keep every source clip reachable.
    const capacity = group.semanticRhythm ? 5 :
      groupSize <= 2 ? groupSize : Math.max(2, Math.min(5, Math.ceil(groupSize / proportionalCards)));
    let pending = [];
    const flush = () => {
      if (!pending.length) return;
      const first = pending[0];
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
        variants: pending
      });
      pending = [];
    };
    for (const packet of group.packets.values()) {
      // Keep the parts of one observed action together where possible.
      if (pending.length && pending.length + packet.length > capacity) flush();
      for (const clip of packet) {
        if (pending.length >= capacity) flush();
        pending.push(clip);
      }
    }
    flush();
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
  const clean = value => text(value).toLocaleLowerCase('tr-TR').replace(/\\s+/g, ' ');
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
