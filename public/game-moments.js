// Story moments taken only from the verified analysis and the source speech:
// a short cinematic title when a new scene starts, a small card the first
// time a person appears, and how much of the playable video was explored.
// Family or step-family roles never appear on these cards.

const FAMILY = /(?<!\p{L})(?:anne\p{L}*|baba\p{L}*|kardeş\p{L}*|kardes\p{L}*|abla\p{L}*|ağabey\p{L}*|agabey\p{L}*|abi(?:si|sini|siyle|m|n|ciğim)?|amca\p{L}*|dayı\p{L}*|dayi\p{L}*|hala(?:sı|sını|sıyla|m|n|cığım)|teyze\p{L}*|üvey\p{L}*|uvey\p{L}*|oğl\p{L}*|ogl\p{L}*|kızı|kizi|kızım|kuzen\p{L}*|yeğen\p{L}*|yegen\p{L}*|step(?:mom|mother|dad|father|sister|brother|son|daughter)\p{L}*|mom|moms|mommy|mother\p{L}*|dad|daddy|father\p{L}*|sister\p{L}*|brother\p{L}*|daughter\p{L}*|aunt\p{L}*|uncle\p{L}*|cousin\p{L}*)(?!\p{L})/iu;
const GENERIC_ROLE = /^(?:kadın|erkek|adam|kişi|partner|karakter|genç kadın|genç adam|olgun kadın|olgun adam|yaşlı kadın|yaşlı adam)$/iu;

const clean = (value, max = 80) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
export const hasFamilyWord = text => FAMILY.test(String(text || ''));

// Scene numbering follows the video: first appearance of each scene key.
export function sceneKeyFor(action = {}) {
  return String(action.adultSceneId || action.sceneId || action.locationId || '').trim();
}
export function sceneChapters(actions = []) {
  const chapters = new Map();
  [...(Array.isArray(actions) ? actions : [])]
    .sort((a, b) => Number(a.startTime) - Number(b.startTime))
    .forEach(action => {
      const key = sceneKeyFor(action);
      if (key && !chapters.has(key)) chapters.set(key, chapters.size + 1);
    });
  return chapters;
}

export function sceneCardContent(action = {}, { chapter = 0, setting = '', names = [] } = {}) {
  let title = clean(action.sceneTitle, 70);
  if (!title || hasFamilyWord(title)) title = hasFamilyWord(setting) ? '' : clean(setting, 70);
  const people = (Array.isArray(names) ? names : []).map(name => clean(name, 40))
    .filter(name => name && !hasFamilyWord(name));
  if (!chapter && !title) return null;
  return { kicker: chapter ? `Bölüm ${chapter}` : '', title, people: [...new Set(people)].slice(0, 3) };
}

// The first Turkish line the person really says (subtitles/dub), if any.
export function firstSpokenLine(character = {}, cues = []) {
  const speakerIds = new Set((character.speakerIds || []).map(String));
  if (!speakerIds.size) return '';
  const line = (Array.isArray(cues) ? cues : [])
    .filter(cue => speakerIds.has(String(cue.speakerId || '')))
    .sort((a, b) => Number(a.start) - Number(b.start))
    .map(cue => clean(cue.text, 140))
    .find(text => text.split(/\s+/).filter(word => /\p{L}{2,}/u.test(word)).length >= 3 && !hasFamilyWord(text));
  return line ? (line.length > 90 ? `${line.slice(0, 88).trim()}…` : line) : '';
}

export function characterCardContent(character = {}, { name = '', cues = [] } = {}) {
  const displayName = clean(name || character.displayName, 40);
  if (!displayName || hasFamilyWord(displayName)) return null;
  const roleText = clean(character.sourceRole || character.role, 40);
  const role = character.evidenceLevel === 'fact' && roleText && !hasFamilyWord(roleText) &&
    !GENERIC_ROLE.test(roleText) && roleText.toLocaleLowerCase('tr-TR') !== displayName.toLocaleLowerCase('tr-TR')
    ? roleText : '';
  return { name: displayName, role, line: firstSpokenLine(character, cues) };
}

// ---- Exploration ----
export function mergeIntervals(list = []) {
  const sorted = list.filter(row => Number.isFinite(row?.start) && Number.isFinite(row?.end) && row.end > row.start)
    .map(row => ({ start: row.start, end: row.end })).sort((a, b) => a.start - b.start);
  const out = [];
  for (const row of sorted) {
    const last = out[out.length - 1];
    if (last && row.start <= last.end + 0.05) last.end = Math.max(last.end, row.end);
    else out.push({ ...row });
  }
  return out;
}
export function playableIntervals(actions = []) {
  return mergeIntervals((Array.isArray(actions) ? actions : [])
    .filter(action => action?.sourceVerified !== false && String(action?.actionType || '') !== 'scene_transition')
    .map(action => ({ start: Number(action.startTime), end: Number(action.endTime) })));
}
const total = list => list.reduce((sum, row) => sum + (row.end - row.start), 0);
function intersect(a, b) {
  const out = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i].start, b[j].start), end = Math.min(a[i].end, b[j].end);
    if (end > start) out.push({ start, end });
    if (a[i].end < b[j].end) i += 1; else j += 1;
  }
  return out;
}
export function createExplorationTracker(playable = [], initial = []) {
  let covered = mergeIntervals(initial);
  let last = null;
  const base = mergeIntervals(playable);
  const totalSeconds = total(base);
  return {
    record(time) {
      const t = Number(time);
      if (!Number.isFinite(t)) return;
      if (last !== null && t > last && t - last <= 1.5) covered = mergeIntervals([...covered, { start: last, end: t }]);
      last = t;
    },
    breakRun() { last = null; },
    percent() { return totalSeconds > 0 ? Math.min(100, Math.round(total(intersect(covered, base)) / totalSeconds * 100)) : 0; },
    covered: () => covered.map(row => ({ ...row }))
  };
}
