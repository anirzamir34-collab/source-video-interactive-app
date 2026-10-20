// One card per real movement of the man ("Saçını tutarak devam et"), with
// small tempo buttons under it (Hızlan / Sertleş / Derine / Yavaşla) that
// play the parts of that same movement where the video really changes pace.
// A button exists only when such a part exists; nothing is invented.

const CHANGES = new Set(['faster', 'slower', 'harder', 'deeper']);
const FLAVOR_FOR_CHANGE = { faster: 'fast', slower: 'slow', harder: 'hard', deeper: 'deep' };

export const TEMPO_OPTIONS = Object.freeze([
  { flavor: 'fast', label: 'Hızlan' },
  { flavor: 'hard', label: 'Sertleş' },
  { flavor: 'deep', label: 'Derine' },
  { flavor: 'slow', label: 'Yavaşla' }
]);

const fold = value => String(value || '').toLocaleLowerCase('tr-TR')
  .replace(/[ıİ]/g, 'i').replace(/ş/g, 's').replace(/ç/g, 'c').replace(/ğ/g, 'g')
  .replace(/ü/g, 'u').replace(/ö/g, 'o').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\s+/g, ' ').trim();

export function normalizeMovementChange(value) {
  const key = String(value || '').trim().toLowerCase();
  return CHANGES.has(key) ? key : 'none';
}

// fast | slow | hard | deep | steady
export function movementFlavor(movement = {}) {
  const change = normalizeMovementChange(movement.movementChange);
  if (change !== 'none') return FLAVOR_FOR_CHANGE[change];
  const tempo = String(movement.movementTempo || '').toLowerCase();
  const words = fold([movement.label, movement.movementType].filter(Boolean).join(' '));
  if (/\b(derin\w*|deep)\b/u.test(words)) return 'deep';
  if (/\b(sert\w*|hard|guclu)\b/u.test(words)) return 'hard';
  if (tempo === 'fast' || /\b(hizli|hizlan\w*|fast)\b|\btempo\w*\s+(artir\w*|yukselt\w*)/u.test(words)) return 'fast';
  if (tempo === 'slow' || /\b(yavas\w*|slow)\b|\btempo\w*\s+(dusur\w*|azalt\w*)/u.test(words)) return 'slow';
  // Measured on the real footage (intensity-engine.js) when the analysis
  // called every part "moderate".
  if (['fast', 'slow'].includes(movement.measuredFlavor)) return movement.measuredFlavor;
  return 'steady';
}

// The movement itself, without the pace words a tempo button already says:
// "Saçını tutarak hızlan" and "Saçını tutarak devam et" are one movement.
export function movementBaseKey(label = '') {
  return fold(label)
    .replace(/\btempo\w*\s+(artir|yukselt|dusur|azalt|degistir)\w*/gu, ' ')
    .replace(/\b(daha\s+)?(hizli|hizlan\w*|yavas\w*|sert\w*|derin\w*|guclu|ritmik|tempolu)\b/gu, ' ')
    .replace(/\b(sekilde|bicimde)\b/gu, ' ')
    .replace(/\b(devam\s+et|surdur|devam)\b/gu, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const cardSource = card => {
  const first = card?.variants?.[0] || {};
  return [card?.sourcePositionId || first.sourcePositionId || '',
    first.positionOccurrenceId || first.sourceOccurrenceId || card?.occurrenceId || ''].join('|');
};

// Cards of the same movement (same position and occurrence) become one card.
export function mergeSameMovementCards(cards = []) {
  const out = [];
  const byKey = new Map();
  for (const card of Array.isArray(cards) ? cards : []) {
    const base = movementBaseKey(card?.label);
    const key = base ? `${cardSource(card)}::${base}` : '';
    const existing = key ? byKey.get(key) : null;
    const flavor = movementFlavor(card?.variants?.[0]);
    if (!existing) {
      const copy = { ...card, variants: [...(card?.variants || [])], labelsByFlavor: { [flavor]: card?.label } };
      out.push(copy);
      if (key) byKey.set(key, copy);
      continue;
    }
    existing.labelsByFlavor[flavor] ??= card.label;
    existing.variants.push(...(card.variants || []));
    existing.variants.sort((a, b) => Number(a.loopStartTime ?? a.startTime) - Number(b.loopStartTime ?? b.startTime));
  }
  return out;
}

// Adds baseVariants (what the card itself plays) and tempoOptions.
export function attachTempoOptions(card = {}) {
  const variants = Array.isArray(card.variants) ? card.variants : [];
  const byFlavor = new Map();
  for (const variant of variants) {
    const flavor = movementFlavor(variant);
    if (!byFlavor.has(flavor)) byFlavor.set(flavor, []);
    byFlavor.get(flavor).push(variant);
  }
  const base = byFlavor.has('steady') ? 'steady'
    : [...byFlavor.entries()].sort((a, b) => b[1].length - a[1].length)[0]?.[0] || 'steady';
  const tempoOptions = byFlavor.size > 1
    ? TEMPO_OPTIONS.filter(option => option.flavor !== base && byFlavor.has(option.flavor))
      .map(option => ({ ...option, variants: byFlavor.get(option.flavor) }))
    : [];
  // The card is worded after the part it plays itself; the tempo buttons
  // already say the change.
  const ownLabel = (byFlavor.get(base) || []).map(item => String(item.label || '').trim()).find(Boolean);
  const label = card.labelsByFlavor?.[base] || (base !== movementFlavor(variants[0]) && ownLabel) || card.label;
  return { ...card, label, baseFlavor: base, baseVariants: byFlavor.get(base) || variants, tempoOptions };
}

export function movementCardsWithTempo(cards = [], { maxCards = 6, bundle = null } = {}) {
  let merged = mergeSameMovementCards(cards);
  if (merged.length > maxCards && typeof bundle === 'function') merged = bundle(merged, { targetCount: maxCards });
  return merged.map(attachTempoOptions);
}
