/** Pure authoritative gameplay state. No DOM, clocks, storage or media effects. */
export const GAMEPLAY_VERSION = 2;
const clamp = (n, max = 100) => Math.min(max, Math.max(0, Number(n) || 0));
const stageOf = state => state.graph.stages.find(row => row.id === state.stageId);
const choiceOf = (state, id) => state.graph.choices.find(row => row.id === id);
const clipOf = (state, id) => state.graph.clips.find(row => row.id === id);
const emptyProgress = () => ({ score: 0, counts: {}, completed: false });

export function createGameplayState(graph, { currentTime = 0 } = {}) {
  const chapter = graph.chapters.find(row => row.endTime > currentTime) || graph.chapters[0];
  return { version: GAMEPLAY_VERSION, graph, fingerprint: graph.fingerprint,
    chapterId: chapter?.id || null, stageId: chapter?.stageIds[0] || null,
    cursor: clamp(currentTime, graph.duration), status: 'decision', selection: null,
    serial: 0, stageProgress: {}, characters: {}, relationships: {}, visual: {},
    visualTime: 0, visualHistory: [], observedClipIds: [], completedChapterIds: [], error: null };
}

export function clipIsContinuous(state, clip) {
  if (!clip) return false;
  const facts = Object.entries(state.visual);
  if (clip.startTime >= state.visualTime - .05) return true;
  // A backward replay needs positive evidence that the already observed state
  // still matches. Missing clothing/location observations do not prove a match.
  return facts.every(([key, value]) => clip.before[key] === value);
}
export function playableChoiceClips(state, choice) {
  return (choice?.clipIds || []).map(id => clipOf(state, id)).filter(clip => clipIsContinuous(state, clip));
}
export function availableChoices(state, graph = state.graph) {
  if (graph.fingerprint !== state.fingerprint) return [];
  const stage = stageOf(state);
  if (!stage) return [];
  const progress = state.stageProgress[stage.id] || emptyProgress();
  let choices = stage.choiceIds.map(id => choiceOf(state, id)).filter(choice => playableChoiceClips(state, choice).length);
  if (stage.phase === 'STORY' && !state.selection) {
    choices = choices.filter(choice => !progress.counts[choice.id] &&
      playableChoiceClips(state, choice).some(clip => clip.endTime > state.cursor + .03));
    // Preserve source-backed narrative actions even when a language model
    // did not return a formal fork/intent. Collapsing every blank intent to
    // "chronological-source" made an entire scene appear as one button.
    // These are navigable recorded events, NOT invented branching outcomes.
    const labelledEvents = choices.filter(choice => {
      const label = String(choice.label || '').trim();
      return !choice.abstained && label && !label.startsWith('Gözlenen kaynak olayı ');
    });
    if (!labelledEvents.length && !choices.some(choice => choice.intent)) {
      choices = choices.slice(0, 1); // no supported meaning, only raw timestamps
    } else {
      const seenIntents = new Set();
      choices = choices.filter(choice => {
        if (!choice.intent) return true; // distinct sourced event, no fictional fork
        if (seenIntents.has(choice.intent)) return false;
        seenIntents.add(choice.intent);
        return true;
      });
    }
  }
  // All source-backed story events and categorized interaction actions must
  // remain addressable. The view handles layout/pagination, never deletes
  // choices or hides the fourth action simply because three cards were shown.
  if (stage.phase === 'CORE' || stage.phase === 'STORY') return choices;
  const discovered = Object.keys(progress.counts).length;
  const limit = stage.choiceIds.length <= 4 ? 4 : Math.min(stage.choiceIds.length, 3 + discovered);
  return choices.slice(0, limit);
}
export function activeSurface(state) {
  return stageOf(state)?.surface || 'story';
}
export function nextPlayableClip(state, selection = state.selection) {
  if (!selection) return null;
  const clip = clipOf(state, selection.clipIds[selection.index]);
  return clipIsContinuous(state, clip) ? clip : null;
}
export function progression(state) {
  const stage = stageOf(state), progress = state.stageProgress[stage?.id] || emptyProgress();
  const chapter = state.graph.chapters.find(row => row.id === state.chapterId);
  const next = chapter?.stageIds[chapter.stageIds.indexOf(state.stageId) + 1] || null;
  const interactiveStages = (chapter?.stageIds || []).map(id =>
    state.graph.stages.find(row => row.id === id)).filter(row => row && row.phase !== 'STORY');
  // The opening meter is earned from distinct, watched approach actions.
  // Counting CORE/AFTERMATH in its denominator made it change after unlock
  // and prevented a sparse but genuinely observed opening from filling.
  const firstCore = interactiveStages.find(row => row.phase === 'CORE');
  const approachStages = interactiveStages.filter(row => row.phase === 'APPROACH' &&
    (!firstCore || row.startTime < firstCore.startTime));
  const approachIds = approachStages.flatMap(row => row.choiceIds);
  const earnedApproaches = approachStages.reduce((sum, row) => sum +
    row.choiceIds.filter(id => state.stageProgress[row.id]?.counts?.[id] > 0).length, 0);
  const lust = approachIds.length ? clamp(100 * earnedApproaches / approachIds.length) : 0;
  const sceneEngagements = interactiveStages.reduce((sum, row) =>
    sum + Object.keys(state.stageProgress[row.id]?.counts || {}).length, 0);
  return { stageId: state.stageId, phase: stage?.phase || 'STORY', value: clamp(progress.score),
    lust, sceneEngagements, completed: progress.completed,
    playedChoices: Object.keys(progress.counts).length,
    nextStageId: progress.completed ? next : null, characters: state.characters, relationships: state.relationships };
}
const stageReady = (state, progress) => {
  const stage = stageOf(state);
  if (!stage) return false;
  if (stage.phase === 'STORY') return !availableChoices({ ...state,
    selection: null, stageProgress: { ...state.stageProgress, [stage.id]: progress } }).length;
  const counts = Object.keys(progress.counts);
  const remaining = availableChoices(state).filter(row => !progress.counts[row.id]);
  // One sourced action may complete its stage, but never award 100% Lust
  // simply because the analyzer returned only one choice.
  if (stage.choiceIds.length === 1) return counts.length === 1;
  return progress.score >= 100 - .001 && counts.length >= Math.min(2, counts.length + remaining.length);
};

function reward(state) {
  const selection = state.selection;
  if (!selection || selection.rewarded) return state;
  const choice = choiceOf(state, selection.choiceId), stage = stageOf(state);
  const previous = state.stageProgress[stage.id] || emptyProgress();
  const count = previous.counts[choice.id] || 0;
  const base = 100 / Math.max(2, Math.min(4, stage.choiceIds.length));
  const gain = base * Math.pow(.5, Math.min(20, count));
  const progress = { ...previous, counts: { ...previous.counts, [choice.id]: count + 1 },
    score: clamp(previous.score + gain) };
  // Meaningful alternatives cannot be exhausted by repeating one brief clip.
  if (Object.keys(progress.counts).length === 1 && stage.choiceIds.length > 1 &&
      availableChoices(state).some(row => row.id !== choice.id)) progress.score = Math.min(75, progress.score);
  progress.completed = previous.completed || stageReady(state, progress);
  const characters = { ...state.characters }, relationships = { ...state.relationships };
  for (const id of choice.cast) characters[id] = { engagements: (characters[id]?.engagements || 0) + 1,
    progress: clamp((characters[id]?.progress || 0) + gain / 4) };
  if (choice.relationship) {
    const key = JSON.stringify([choice.relationship.from, choice.relationship.to]);
    relationships[key] = { ...choice.relationship, progress: clamp((relationships[key]?.progress || 0) + gain / 4) };
  }
  return { ...state, stageProgress: { ...state.stageProgress, [stage.id]: progress }, characters, relationships,
    selection: { ...selection, rewarded: true } };
}
function observeFacts(state, clip, completed = false) {
  const facts = { ...clip.before, ...(completed ? clip.after : {}) };
  if (!Object.keys(facts).length) return state;
  const visualHistory = state.visualHistory.filter(row => row.clipId !== clip.id);
  visualHistory.push({ clipId: clip.id, completed });
  return { ...state, visual: { ...state.visual, ...facts }, visualHistory,
    visualTime: Math.max(state.visualTime, completed ? clip.endTime : clip.startTime) };
}
function finishSelection(state) {
  const stage = stageOf(state);
  let progress = state.stageProgress[stage.id] || emptyProgress();
  progress = { ...progress, completed: progress.completed || stageReady(state, progress) };
  return { ...state, selection: null, status: 'decision', error: null,
    stageProgress: { ...state.stageProgress, [stage.id]: progress } };
}

export function gameplayReducer(state, event = {}) {
  if (!state?.graph) throw new TypeError('GAMEPLAY_GRAPH_REQUIRED');
  switch (event.type) {
    case 'SELECT': {
      const choice = availableChoices(state).find(row => row.id === event.choiceId);
      if (!choice) return state;
      const clipIds = playableChoiceClips(state, choice).map(row => row.id);
      if (!clipIds.length) return state;
      return { ...state, serial: state.serial + 1, status: 'seeking', error: null,
        selection: { id: state.serial + 1, choiceId: choice.id, clipIds, index: 0,
          observed: 0, lastTime: null, rewarded: false, started: false } };
    }
    case 'PLAYING': {
      if (!state.selection || event.selectionId !== state.selection.id) return state;
      const clip = nextPlayableClip(state);
      if (!clip) return finishSelection(state);
      return { ...state, status: 'playing', error: null,
        selection: { ...state.selection, started: true, lastTime: clip.startTime } };
    }
    case 'PAUSE':
      return state.selection ? { ...state, status: 'paused', selection: { ...state.selection, lastTime: null } } : state;
    case 'RESUME':
      return state.selection ? { ...state, status: 'playing', selection: { ...state.selection, lastTime: null } } : state;
    case 'PLAYBACK': {
      const sel = state.selection, clip = nextPlayableClip(state);
      if (!sel || !clip || event.selectionId !== sel.id || state.status !== 'playing' ||
          !sel.started || event.seeking || event.playing !== true || !Number.isFinite(event.time)) return state;
      const time = event.time;
      if (sel.lastTime !== null && time <= sel.lastTime) return state;
      const delta = sel.lastTime === null ? 0 : time - sel.lastTime;
      // The adapter supplies monotonic elapsed wall time. Timeupdate jumps or a
      // seek cannot manufacture watched seconds, even without a seeking event.
      const wall = Number.isFinite(event.elapsed) ? Math.max(0, event.elapsed) : 0;
      const valid = delta > 0 && delta <= wall * Math.max(1, Number(event.rate) || 1) + .15;
      const watched = valid ? Math.max(0, Math.min(time, clip.endTime) - Math.max(sel.lastTime, clip.startTime)) : 0;
      let next = { ...state, cursor: Math.max(state.cursor, Math.min(time, clip.endTime)),
        selection: { ...sel, lastTime: time, observed: Math.min(clip.endTime - clip.startTime, sel.observed + watched) } };
      if (watched > 0) next = observeFacts(next, clip);
      if (next.selection.observed >= Math.min(3, (clip.endTime - clip.startTime) * .65) - .001) next = reward(next);
      return next;
    }
    case 'CLIP_ENDED': {
      const sel = state.selection, clip = nextPlayableClip(state);
      const boundary = clip?.previewEndTime ?? clip?.endTime;
      if (!sel || !clip || event.selectionId !== sel.id || !sel.started || !Number.isFinite(event.time) || event.time < boundary - .04) return state;
      let next = state;
      // A preview confirms engagement, not the unseen end-state of a long
      // action. Clothing/posture after-facts require the actual source end.
      if (event.time >= clip.endTime - .04 &&
          sel.observed >= Math.min(3, (clip.endTime - clip.startTime) * .65) - .001) {
        next = observeFacts(next, clip, true);
        next = { ...next, observedClipIds: [...new Set([...next.observedClipIds, clip.id])] };
      }
      next = { ...next, cursor: Math.max(next.cursor, Math.min(state.graph.duration, event.time)) };
      const index = sel.index + 1;
      if (index < sel.clipIds.length && clipIsContinuous(next, clipOf(next, sel.clipIds[index]))) {
        return { ...next, status: 'seeking', selection: { ...next.selection, index, observed: 0, lastTime: null, started: false } };
      }
      return finishSelection(next);
    }
    case 'CONTINUE_SOURCE':
      // Source-only playback across an unanalysed gap. No choice is selected,
      // and its elapsed time never awards narrative or relationship progress.
      return { ...state, selection: null, status: 'continuing', error: null };
    case 'MEDIA_FAILURE':
      return state.selection ? state : { ...state, status: 'decision', error: String(event.message || 'Video oynatılamadı.') };
    case 'FAIL':
      if (!state.selection || event.selectionId !== state.selection.id) return state;
      return { ...state, status: 'error', error: String(event.message || 'Video oynatılamadı.'),
        selection: { ...state.selection, started: false, lastTime: null } };
    case 'RETRY':
      return state.selection && state.status === 'error' ? { ...state, status: 'seeking', error: null,
        selection: { ...state.selection, observed: 0, lastTime: null, started: false } } : state;
    case 'CANCEL':
      return { ...state, status: 'decision', selection: null, error: null };
    case 'SKIP_CURRENT_CLIP': {
      const clip = nextPlayableClip(state);
      if (!state.selection || !clip || clip.id !== event.clipId) return state;
      // Skipping only advances the source cursor. It does not create visual
      // facts, grant a completion reward, or jump over the entire story.
      return { ...state, cursor: Math.max(state.cursor, clip.endTime),
        selection: null, status: 'decision', error: null };
    }
    case 'ADVANCE_STAGE': {
      const next = progression(state).nextStageId;
      if (!next || state.selection) return state;
      return { ...state, stageId: next, status: 'decision', error: null };
    }
    case 'SKIP_STAGE': {
      if (state.selection) return state;
      const chapter = state.graph.chapters.find(row => row.id === state.chapterId);
      const nextStageId = chapter?.stageIds[chapter.stageIds.indexOf(state.stageId) + 1];
      if (!nextStageId) return gameplayReducer(state, { type: 'NEXT_CHAPTER' });
      const next = state.graph.stages.find(row => row.id === nextStageId);
      return { ...state, stageId: nextStageId, cursor: next.startTime,
        status: 'decision', error: null };
    }
    case 'NEXT_CHAPTER': {
      if (state.selection) return state;
      const index = state.graph.chapters.findIndex(row => row.id === state.chapterId);
      const chapter = state.graph.chapters[index + 1];
      return { ...state, chapterId: chapter?.id || null, stageId: chapter?.stageIds[0] || null,
        cursor: chapter ? chapter.startTime : state.cursor,
        completedChapterIds: [...new Set([...state.completedChapterIds, state.chapterId].filter(Boolean))],
        status: chapter || state.cursor < state.graph.duration - .05 ? 'decision' : 'ended', error: null };
    }
    case 'SEEK': {
      if (!Number.isFinite(event.time)) return state;
      const cursor = clamp(event.time, state.graph.duration);
      if (cursor < state.visualTime && event.rewind !== true) return { ...state, selection: null,
        status: 'decision', error: 'Önceki görsel duruma dönmek için Geri sar seçeneğini kullan.' };
      const chapter = state.graph.chapters.find(row => row.startTime <= cursor + .03 && row.endTime > cursor);
      // Overlapping source events are separate playable layers. At their
      // start, select the most specific later event, not an enclosing monologue.
      const stage = chapter && state.graph.stages.filter(row => row.chapterId === chapter.id &&
        row.startTime <= cursor + .03 && row.endTime > cursor)
        .sort((a, b) => b.startTime - a.startTime || a.endTime - b.endTime)[0];
      let next = { ...state, cursor, chapterId: chapter?.id || null, stageId: stage?.id || null,
        status: chapter ? 'decision' : 'ended', selection: null, error: null };
      if (event.rewind === true) {
        next = { ...next, visual: {}, visualTime: 0, visualHistory: [] };
        for (const clip of state.graph.clips.filter(row => row.endTime <= cursor && state.observedClipIds.includes(row.id))) {
          next = observeFacts(next, clip, true);
        }
      }
      return next;
    }
    default: return state;
  }
}

export function captureGameplay(state) {
  const { graph, selection, error, ...snapshot } = state;
  return structuredClone({ ...snapshot, status: 'decision' });
}
export function restoreGameplay(graph, snapshot) {
  const fresh = createGameplayState(graph);
  if (!snapshot || snapshot.version !== GAMEPLAY_VERSION) return fresh;
  // Graph metadata was extended without changing stable stage/choice IDs.
  // Preserve v2 saves only when their stage and every recorded choice still
  // exist in the rebuilt source graph; reject unrelated/tampered snapshots.
  const compatible = snapshot.fingerprint === graph.fingerprint ||
    (typeof snapshot.fingerprint === 'string' && snapshot.fingerprint.startsWith('vq2-') &&
      graph.stages.some(row => row.id === snapshot.stageId) &&
      Object.entries(snapshot.stageProgress || {}).every(([stageId, progress]) => {
        const stage = graph.stages.find(row => row.id === stageId);
        return stage && Object.keys(progress?.counts || {}).every(id => stage.choiceIds.includes(id));
      }));
  if (!compatible) return fresh;
  // Restore validated data, never replay selection/playback events. Counters
  // alone cannot reconstruct the chronological diminishing-return/retirement
  // decisions that produced a score, so preserve the bounded recorded score.
  const stageProgress = {};
  for (const stage of graph.stages) {
    const saved = snapshot.stageProgress?.[stage.id];
    if (!saved) continue;
    const counts = Object.fromEntries(stage.choiceIds.filter(id => Number.isSafeInteger(saved.counts?.[id]) &&
      saved.counts[id] > 0 && saved.counts[id] <= 1000).map(id => [id, saved.counts[id]]));
    const maximum = Object.values(counts).reduce((sum, count) => sum +
      100 / Math.max(2, Math.min(4, stage.choiceIds.length)) * 2 * (1 - Math.pow(.5, count)), 0);
    stageProgress[stage.id] = { counts, score: Math.min(clamp(saved.score), maximum), completed: false };
  }
  let restored = { ...fresh, stageProgress,
    observedClipIds: graph.clips.map(row => row.id).filter(id => Array.isArray(snapshot.observedClipIds) && snapshot.observedClipIds.includes(id)),
    serial: Number.isSafeInteger(snapshot.serial) ? Math.max(0, snapshot.serial) : 0,
    cursor: clamp(snapshot.cursor, graph.duration) };
  for (const row of Array.isArray(snapshot.visualHistory) ? snapshot.visualHistory.slice(-graph.clips.length) : []) {
    const clip = clipOf(restored, row.clipId);
    if (clip && typeof row.completed === 'boolean') restored = observeFacts(restored, clip, row.completed);
  }
  const target = graph.stages.find(row => row.id === snapshot.stageId);
  if (target) restored = { ...restored, chapterId: target.chapterId, stageId: target.id };
  else if (snapshot.chapterId === null && restored.cursor >= graph.duration - .05) {
    restored = { ...restored, chapterId: null, stageId: null, status: 'ended' };
  }
  for (const stage of graph.stages) {
    const progress = stageProgress[stage.id];
    if (progress) progress.completed = stageReady({ ...restored, stageId: stage.id, chapterId: stage.chapterId }, progress);
  }
  const characterIds = new Set(graph.choices.flatMap(row => row.cast));
  const characters = {};
  for (const id of characterIds) {
    const saved = snapshot.characters?.[id];
    if (saved && Number.isSafeInteger(saved.engagements) && saved.engagements >= 0) characters[id] = {
      engagements: Math.min(100000, saved.engagements), progress: clamp(saved.progress) };
  }
  const relationships = {};
  for (const choice of graph.choices) if (choice.relationship) {
    const key = JSON.stringify([choice.relationship.from, choice.relationship.to]);
    if (snapshot.relationships?.[key]) relationships[key] = { ...choice.relationship,
      progress: clamp(snapshot.relationships[key].progress) };
  }
  return { ...restored, characters, relationships,
    completedChapterIds: graph.chapters.map(row => row.id).filter(id => snapshot.completedChapterIds?.includes(id)),
    error: null, selection: null };
}
