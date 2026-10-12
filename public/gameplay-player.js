import { createGameplayState, gameplayReducer, nextPlayableClip, restoreGameplay, captureGameplay } from './gameplay-state.js';
import { seekMediaTo, playMedia } from './playback-logic.js';

/** Media effect owner. All game decisions are reducer events; observers may
 * synchronize subtitles/audio but must not mutate gameplay state. */
export function createGameplayPlayer({ graph, video, snapshot, onChange = () => {},
  conversationEndAt = time => time, now = () => performance.now(),
  seek = seekMediaTo, play = playMedia } = {}) {
  let state = snapshot ? restoreGameplay(graph, snapshot) : createGameplayState(graph);
  let operation = null, destroyed = false, lastWall = now(), internalSeek = false, boundaryBusy = false, freePlayback = false;
  let frame = null;
  const dispatch = event => {
    if (destroyed) return state;
    state = gameplayReducer(state, event); onChange(state); return state;
  };
  const cancelEffect = () => { operation?.abort(); operation = null; internalSeek = false; boundaryBusy = false; };
  async function playSelected() {
    cancelEffect(); freePlayback = false;
    const clip = nextPlayableClip(state), selectionId = state.selection?.id;
    if (!clip) return;
    const controller = new AbortController(); operation = controller;
    video.pause(); internalSeek = true;
    try {
      await seek(video, clip.startTime, { signal: controller.signal });
      if (controller.signal.aborted || destroyed) return;
      internalSeek = false;
      dispatch({ type: 'PLAYING', selectionId });
      await play(video, { signal: controller.signal });
      if (controller.signal.aborted || destroyed) return;
      lastWall = now();
    } catch (error) {
      if (controller.signal.aborted || destroyed) return;
      internalSeek = false;
      dispatch({ type: 'FAIL', selectionId, message: 'Video oynatılamadı. Yeniden dene.' });
    }
  }
  async function sample(time = video.currentTime) {
    if (destroyed || boundaryBusy) return;
    const wall = now(), elapsed = Math.max(0, (wall - lastWall) / 1000); lastWall = wall;
    if (freePlayback) {
      const next = graph.chapters.find(row => row.startTime > state.cursor + .05);
      if (next && time >= next.startTime - .03) {
        freePlayback = false; video.pause(); dispatch({ type: 'SEEK', time: next.startTime });
      }
      return;
    }
    const selectionId = state.selection?.id, clip = nextPlayableClip(state);
    if (!clip || state.status !== 'playing') return;
    dispatch({ type: 'PLAYBACK', selectionId, time, elapsed,
      rate: video.playbackRate || 1, playing: !video.paused, seeking: internalSeek || video.seeking });
    if (time < clip.endTime - .03 || video.seeking || internalSeek) return;
    const stage = graph.stages.find(row => row.id === state.stageId);
    // Preserve existing source/dub sentence continuity for story decisions.
    if (stage?.surface === 'story' && !video.ended && conversationEndAt(time) > time + .03) return;
    boundaryBusy = true;
    video.pause();
    dispatch({ type: 'CLIP_ENDED', selectionId, time });
    if (state.selection && state.status === 'seeking') await playSelected();
    boundaryBusy = false;
  }
  const onTime = () => { void sample(); };
  const onSeeking = () => {
    if (internalSeek) return;
    cancelEffect(); freePlayback = false;
    dispatch({ type: 'CANCEL' });
  };
  const onSeeked = () => {
    if (internalSeek || operation && state.selection) return;
    video.pause(); dispatch({ type: 'SEEK', time: video.currentTime });
    if (state.error) {
      internalSeek = true;
      void seek(video, state.cursor).catch(() => dispatch({ type: 'MEDIA_FAILURE', message: 'Önceki kaynak konumuna dönülemedi.' }))
        .finally(() => { internalSeek = false; });
    }
  };
  const onPause = () => {
    if (state.status === 'playing' && !boundaryBusy && !internalSeek) dispatch({ type: 'PAUSE' });
  };
  const onPlay = () => {
    lastWall = now();
    if (state.status === 'paused') dispatch({ type: 'RESUME' });
  };
  const onEnded = () => { void sample(); if (!state.selection) { freePlayback = false; dispatch({ type: 'SEEK', time: graph.duration }); } };
  const onError = () => { if (state.selection) dispatch({ type: 'FAIL', selectionId: state.selection.id }); };
  const listeners = { timeupdate: onTime, seeking: onSeeking, seeked: onSeeked, pause: onPause, play: onPlay,
    ended: onEnded, error: onError };
  for (const [name, listener] of Object.entries(listeners)) video.addEventListener(name, listener);
  const onFrame = (_time, metadata) => {
    void sample(metadata.mediaTime);
    if (!destroyed) frame = video.requestVideoFrameCallback(onFrame);
  };
  if (video.requestVideoFrameCallback) frame = video.requestVideoFrameCallback(onFrame);
  const api = {
    getState: () => state,
    capture: () => captureGameplay(state),
    render: () => onChange(state),
    sample,
    async select(choiceId) {
      const previous = state.selection;
      dispatch({ type: 'SELECT', choiceId });
      if (state.selection === previous) return;
      await playSelected();
    },
    async retry() { dispatch({ type: 'RETRY' }); if (state.status === 'seeking') await playSelected(); },
    async resume() {
      if (destroyed || !state.selection) return;
      const selectionId = state.selection.id;
      cancelEffect(); const controller = new AbortController(); operation = controller;
      try {
        dispatch({ type: 'RESUME' }); await play(video, { signal: controller.signal });
        if (!controller.signal.aborted) lastWall = now();
      } catch { if (!controller.signal.aborted) dispatch({ type: 'FAIL', selectionId }); }
    },
    advanceStage() { dispatch({ type: 'ADVANCE_STAGE' }); },
    nextChapter() {
      cancelEffect(); freePlayback = false; video.pause(); dispatch({ type: 'CANCEL' }); dispatch({ type: 'NEXT_CHAPTER' });
    },
    async navigate(time, { rewind = false, preserveState = false } = {}) {
      cancelEffect(); freePlayback = false; video.pause();
      if (!preserveState) dispatch({ type: 'SEEK', time, rewind });
      if (state.error) return;
      const controller = new AbortController(); operation = controller; internalSeek = true;
      try { await seek(video, state.cursor, { signal: controller.signal }); }
      catch (error) { if (!controller.signal.aborted) dispatch({ type: 'MEDIA_FAILURE', message: error.message }); }
      finally { if (operation === controller) { operation = null; internalSeek = false; } }
    },
    async continueVideo() {
      if (destroyed) return;
      cancelEffect(); dispatch({ type: 'CANCEL' }); freePlayback = true;
      const controller = new AbortController(); operation = controller;
      try { await play(video, { signal: controller.signal }); }
      catch {
        if (controller.signal.aborted) return;
        freePlayback = false; dispatch({ type: 'MEDIA_FAILURE', message: 'Devam etmek için videoya dokun.' });
      }
    },
    destroy() {
      destroyed = true; cancelEffect();
      for (const [name, listener] of Object.entries(listeners)) video.removeEventListener(name, listener);
      if (frame !== null) video.cancelVideoFrameCallback?.(frame);
    }
  };
  return api;
}
