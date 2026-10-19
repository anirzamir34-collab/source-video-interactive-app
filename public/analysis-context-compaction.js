// Token-lean context for Gemini requests. Nothing here changes what the model
// sees in the frames or which facts it receives; it only drops duplicated
// fields and shortens audit-only evidence strings that are resent per chunk.

const text = value => String(value ?? '').trim();
const short = (value, limit) => {
  const clean = text(value).replace(/\s+/g, ' ');
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
};

// Each transcript row used to carry the same sentence twice (originalText and
// text) and its translation twice (textTr and turkishText).
export function compactDialogueSegments(segments = []) {
  return (Array.isArray(segments) ? segments : []).map(row => {
    const original = text(row?.originalText ?? row?.text);
    const turkish = text(row?.textTr ?? row?.turkishText);
    const compact = {
      segmentId: row?.segmentId, speakerId: row?.speakerId,
      startTime: row?.startTime, endTime: row?.endTime, originalText: original
    };
    if (turkish && turkish !== original) compact.textTr = turkish;
    if (text(row?.speakerName)) compact.speakerName = text(row.speakerName);
    if (row?.gender && row.gender !== 'uncertain') compact.gender = row.gender;
    if (row?.emotion && row.emotion !== 'uncertain') compact.emotion = row.emotion;
    if (Number.isFinite(Number(row?.confidence))) compact.confidence = Number(Number(row.confidence).toFixed(2));
    return Object.fromEntries(Object.entries(compact).filter(([, value]) => value !== undefined && value !== ''));
  });
}

// Prior-chunk memory keeps every fact, inference, unknown, character and
// relationship; only the long audit evidence strings are shortened.
const EVIDENCE_LIMIT = 110;
export function compactStoryMemory(memory) {
  if (!memory || typeof memory !== 'object') return memory || {};
  const trimEvidence = item => item && typeof item === 'object'
    ? { ...item, ...(item.evidence !== undefined ? { evidence: short(item.evidence, EVIDENCE_LIMIT) } : {}),
      ...(item.voiceMatchEvidence !== undefined ? { voiceMatchEvidence: Array.isArray(item.voiceMatchEvidence)
        ? item.voiceMatchEvidence.slice(0, 2).map(value => typeof value === 'string' ? short(value, EVIDENCE_LIMIT) : value)
        : short(item.voiceMatchEvidence, EVIDENCE_LIMIT) } : {}) }
    : item;
  return { ...memory,
    characters: (memory.characters || []).map(trimEvidence),
    relationships: (memory.relationships || []).map(trimEvidence),
    facts: (memory.facts || []).map(trimEvidence),
    inferences: (memory.inferences || []).map(trimEvidence) };
}
