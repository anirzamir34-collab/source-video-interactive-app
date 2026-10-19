// Dubbing translates spoken dialogue only. Moans, breaths and bare
// exclamations ("ah", "ohh", "mmm", "yes yes", "oh my god") stay in the
// original voice: they are moved out of the utterance list into the
// transcript's non-speech audio events, which the mix never replaces.
const SOUND = /^(?:o+h*|a+h*|h?m+h?m*|mhm+|u+h+|h+u+h+|u+m+|e+h+|h+a+(?:h+a+)*h*|h+e+(?:h+e+)*|o+o+f+|o+w+|ou+ch+|ug+h+|w+o+a+h*|who+a+|wo+w+|y+e+a+h*|y+e+s+|y+e+p+|n+o+|f+u+c+k+(?:i+n+g*)?|s+h+i+t+|d+a+m+n+|g+o+d+|j+e+s+u+s+|m+y+|b+a+b+y+|p+l+e+a+s+e+|r+i+g+h+t+|o+k+(?:a+y+)?)$/u;
// Words that are real speech on their own; an utterance needs at least one
// pure sound or a repeat to count as a vocalization rather than an answer.
const WORDISH = new Set(['yes', 'yeah', 'yep', 'no', 'fuck', 'fucking', 'shit', 'damn', 'god', 'jesus', 'my', 'baby', 'please', 'right', 'ok', 'okay']);

function tokens(text) {
  return String(text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\s'-]/gu, ' ').split(/[\s-]+/).map(word => word.replace(/'/g, '')).filter(Boolean);
}

function squeeze(word) {
  return word.replace(/(.)\1{2,}/g, '$1$1');
}

export function isVocalization(utterance) {
  const text = utterance?.sourceText ?? (utterance?.words || []).filter(word => word.type === 'word')
    .map(word => word.text).join(' ');
  const words = tokens(text);
  if (!words.length || words.length > 6) return false;
  if (!words.every(word => SOUND.test(word))) return false;
  const pureSound = words.some(word => !WORDISH.has(squeeze(word).replace(/(.)\1+/g, '$1')) && !WORDISH.has(word));
  const repeated = words.length >= 2 && new Set(words.map(word => squeeze(word).replace(/(.)\1+/g, '$1'))).size < words.length;
  const elongated = words.some(word => /(.)\1{2,}/.test(word));
  const curse = words.length === 1 && /^(?:f+u+c+k+|s+h+i+t+|d+a+m+n+)$/.test(words[0]);
  return pureSound || repeated || elongated || curse;
}

export function separateVocalizations(transcript) {
  const kept = [], moved = [];
  for (const row of transcript.utterances || []) (isVocalization(row) ? moved : kept).push(row);
  if (!moved.length) return 0;
  transcript.utterances = kept;
  transcript.audioEvents = [...(transcript.audioEvents || []), ...moved.map(row => ({
    eventId: `vocal-${row.segmentId}`, type: 'audio_event', kind: 'vocalization',
    text: row.sourceText, start: row.sourceStart, end: row.sourceEnd, speakerId: row.speakerId ?? null
  }))].sort((a, b) => Number(a.start) - Number(b.start));
  return moved.length;
}
