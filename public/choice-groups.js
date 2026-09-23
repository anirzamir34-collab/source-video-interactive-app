import { clipRange } from './sequence-integrity.js';

const text = value => String(value || '').trim();
export const sourceActionLabel = value => text(value)
  .replace(/\s*·\s*(?:Sekans|Bölüm)\s+\d+$/iu, '').trim();

export function sourceIdentityLabel(value, clip = {}) {
  const label = sourceActionLabel(value);
  if (!label || clip?.relationshipResolution === 'verified') return label;
  const identity = ['verified', 'described'].includes(clip?.identityResolution)
    ? text(clip.primaryCharacterLabel)
    : '';
  if (!identity || /^(?:karakter|ana karakter|partner|kadın|erkek|adam|kişi)(?:\s+\S+)?$/iu.test(identity) ||
      label.toLocaleLowerCase('tr-TR').includes(identity.toLocaleLowerCase('tr-TR'))) return label;
  return `${label} · ${identity}`;
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
  const source = (Array.isArray(clips) ? clips : [])
    .filter(clip => clip?.sourceVerified === true && clip.id && clipRange(clip))
    .sort((a, b) => clipRange(a).startTime - clipRange(b).startTime || String(a.id).localeCompare(String(b.id)));
  const requestedTarget = Math.max(1, Math.min(8, Math.floor(Number(preferredCount) || 5)));
  // A card is a coherent source packet, not a separate button for each clip.
  const target = Math.min(requestedTarget, Math.max(1, Math.ceil(source.length / 4)));
  const groups = new Map();
  for (const clip of source) {
    const label = sourceActionLabel(labelFor?.(clip) || clip.label);
    const rawProfile = bandFor?.(clip) || text(clip.movementTempo) || 'unclear';
    const profile = rawProfile && typeof rawProfile === 'object'
      ? rawProfile
      : { key: text(rawProfile) || 'unclear', intensityBand: text(rawProfile) || 'unclear' };
    const band = text(profile.key) || 'unclear';
    const occurrence = text(contextFor?.(clip));
    const declaredScope = [text(clip.adultSceneId), text(clip.sourcePositionId), text(clip.positionOccurrenceId)];
    const hasScope = Boolean(occurrence || declaredScope.some(Boolean));
    const rawType = text(clip.actionType || clip.movementType).toLocaleLowerCase('tr-TR');
    const kind = !rawType ? ''
      : /(?:position|tempo|movement|rhythm|thrust|ritim|hareket)/u.test(rawType) ? 'movement'
        : 'contact';
    const stableContext = mergeWithinContext && occurrence;
    const key = JSON.stringify([
      occurrence || declaredScope,
      stableContext ? '' : text(clip.partnerTrackId),
      stableContext ? '' : text(clip.subjectTrackId),
      stableContext ? '' : text(clip.primaryCharacterId),
      stableContext ? [] : [...(clip.participantTrackIds || [])].map(text).sort(),
      stableContext ? '' : text(clip.receiverBodyOrientation),
      stableContext ? '' : text(clip.receiverSupport), band,
      stableContext ? ''
        : hasScope && kind && kind !== 'other' ? kind : label.toLocaleLowerCase('tr-TR'),
      hasScope ? '' : text(clip.derivedFromVerifiedSegment || clip.id)
    ]);
    if (!groups.has(key)) groups.set(key, { key, band, profile, occurrence, packets: new Map() });
    const group = groups.get(key);
    const origin = text(clip.derivedFromVerifiedSegment || clip.id);
    if (!group.packets.has(origin)) group.packets.set(origin, []);
    group.packets.get(origin).push(clip);
  }
  const cards = [];
  for (const group of groups.values()) {
    const groupSize = [...group.packets.values()].reduce((sum, packet) => sum + packet.length, 0);
    const proportionalCards = Math.max(1, Math.round(target * groupSize / Math.max(1, source.length)));
    const capacity = groupSize <= 2 ? groupSize : Math.max(3, Math.min(5, Math.ceil(groupSize / proportionalCards)));
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
