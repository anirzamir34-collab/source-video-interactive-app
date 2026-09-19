// Presentation helpers only: never seek, play, change speed or generate clips.
import { cleanPanelDisplayLabels } from './display-labels.js';

const timeNumber = value => value === null || value === '' || typeof value === 'boolean'
  ? NaN : Number(value);

export function forwardVerifiedClips(clips = [], { currentId = '', after = 0 } = {}) {
  const seen = new Set();
  return clips.filter(clip => {
    const start = timeNumber(clip?.loopStartTime);
    const end = timeNumber(clip?.loopEndTime);
    if (clip?.sourceVerified !== true || clip.id === currentId || !clip.id ||
        !Number.isFinite(start) || !Number.isFinite(end) || end <= start ||
        start < Math.max(0, Number(after) || 0) - 0.01) return false;
    const key = `${clip.id}:${start}:${end}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => Number(a.loopStartTime) - Number(b.loopStartTime));
}

export function clipPlaybackFeedback(clip, media = {}) {
  const start = timeNumber(clip?.loopStartTime ?? clip?.startTime);
  const end = timeNumber(clip?.loopEndTime ?? clip?.endTime);
  const time = Number(media.currentTime) || 0;
  if (!clip || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return { state: 'idle', label: 'Seçimini yap', progress: 0 };
  }
  const progress = Math.max(0, Math.min(1, (time - start) / (end - start)));
  if (media.failed) return { state: 'error', label: 'Yeniden dene', progress };
  if (media.seeking) return { state: 'loading', label: 'Hazırlanıyor', progress: 0 };
  if (time >= end - 0.04) return { state: 'complete', label: 'Tamamlandı', progress: 1 };
  if (media.waiting || time < start - 0.15) return { state: 'loading', label: 'Hazırlanıyor', progress };
  if (media.paused) return { state: 'paused', label: 'Duraklatıldı', progress };
  return { state: 'playing', label: 'Oynuyor', progress };
}

export function attachPanelFeedback({ stage, panel, choices, video, getSnapshot }) {
  if (!stage || !panel || !video) return () => {};
  const doc = stage.ownerDocument;
  const win = doc.defaultView;
  let frame = null;
  let waiting = false;
  let lastClip = null;
  let lastScope = null;
  const text = (element, value) => {
    if (element && element.textContent !== value) element.textContent = value;
  };
  const update = () => {
    frame = null;
    const snapshot = getSnapshot();
    if (snapshot.scope !== lastScope) {
      lastClip = null;
      lastScope = snapshot.scope;
    }
    if (snapshot.clip) lastClip = snapshot.clip;
    const clip = snapshot.clip || lastClip;
    const feedback = clipPlaybackFeedback(clip, {
      currentTime: video.currentTime, paused: video.paused,
      waiting: waiting || snapshot.buffering,
      seeking: video.seeking || snapshot.seeking, failed: snapshot.failed
    });
    // No active clip means playback status may only retain a completed clip.
    const visible = snapshot.clip || feedback.state === 'complete';
    const label = visible ? feedback.label : 'Seçimini yap';
    text(doc.getElementById('panelPlaybackStatus'), label);
    stage.classList.toggle('panel-playing', visible && feedback.state === 'playing');
    for (const root of [panel, choices].filter(Boolean)) {
      for (const card of root.querySelectorAll('[data-variant-ids], [data-clip-id]')) {
        const ids = card.dataset.variantIds?.split(',') || [card.dataset.clipId];
        const active = visible && clip && ids.includes(String(clip.id || clip.actionId));
        let status = card.querySelector('[data-playback-status]');
        if (!status) {
          status = doc.createElement('small');
          status.dataset.playbackStatus = '';
          card.appendChild(status);
        }
        text(status, active ? label : 'Seçilebilir');
        const nextState = active ? feedback.state : 'idle';
        if (card.dataset.playback !== nextState) card.dataset.playback = nextState;
        card.style.setProperty('--clip-progress', active ? feedback.progress.toFixed(3) : '0');
      }
    }
  };
  const schedule = () => { if (frame === null) frame = win.requestAnimationFrame(update); };
  const onMedia = event => {
    if (event.type === 'waiting' || event.type === 'stalled') waiting = true;
    if (['playing', 'canplay', 'loadeddata', 'emptied'].includes(event.type)) waiting = false;
    if (event.type === 'emptied') { lastClip = null; lastScope = null; }
    schedule();
  };
  const events = ['timeupdate', 'playing', 'pause', 'waiting', 'stalled', 'canplay',
    'seeking', 'seeked', 'ended', 'loadeddata', 'emptied', 'error'];
  events.forEach(event => video.addEventListener(event, onMedia));
  const cleanLabels = () => {
    cleanPanelDisplayLabels(panel);
    cleanPanelDisplayLabels(choices);
  };
  const observer = new win.MutationObserver(() => {
    // Rendering textContent/innerHTML must not reintroduce tracking labels.
    // Clean text nodes before paint without replacing buttons or listeners.
    cleanLabels();
    schedule();
  });
  // Observe structure, not our own progress/style updates.
  observer.observe(panel, { childList: true, subtree: true });
  if (choices) observer.observe(choices, { childList: true, subtree: true });
  cleanLabels();
  schedule();
  return () => {
    observer.disconnect();
    events.forEach(event => video.removeEventListener(event, onMedia));
    if (frame !== null) win.cancelAnimationFrame(frame);
  };
}
