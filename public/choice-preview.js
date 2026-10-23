// Card preview: hovering a card (desktop) or holding it (touch) shows a
// silent 3-second loop of the very part it plays, from the local video file.
// A preview is never a choice: releasing a held card does not select it.
// Remote (non-blob) sources are never previewed, so no extra traffic.

const HOVER_DELAY = 350;
const HOLD_DELAY = 450;
const PREVIEW_SECONDS = 3;

export function previewRange(start, end, seconds = PREVIEW_SECONDS) {
  const from = Number(start), to = Number(end);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
  // Skip the first moment of a part (often still moving into the shot).
  const offset = Math.min(1, Math.max(0, (to - from - seconds) / 2));
  const begin = from + offset;
  return { start: begin, end: Math.min(to, begin + seconds) };
}

export function createChoicePreview({ getSource, document: doc = globalThis.document } = {}) {
  let box = null, video = null, range = null, hoverTimer = null, holdTimer = null, owner = null;
  const ensure = () => {
    if (box || !doc?.createElement) return box;
    box = doc.createElement('div');
    box.className = 'choice-preview hidden';
    box.setAttribute('aria-hidden', 'true');
    video = doc.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.setAttribute('playsinline', '');
    video.addEventListener('timeupdate', () => {
      if (range && video.currentTime >= range.end - 0.05) video.currentTime = range.start;
    });
    box.appendChild(video);
    doc.body.appendChild(box);
    return box;
  };
  const hide = () => {
    clearTimeout(hoverTimer); clearTimeout(holdTimer);
    hoverTimer = holdTimer = null;
    owner = null;
    if (!box) return;
    box.classList.add('hidden');
    try { video.pause(); } catch { /* ignore */ }
  };
  const show = (button, start, end) => {
    const source = String(getSource?.() || '');
    // A card whose next part changes passes a function for its range.
    const live = typeof start === 'function' ? start() : { start, end };
    range = previewRange(live?.start, live?.end);
    if (!range || !source.startsWith('blob:') || !button.isConnected) return false;
    ensure();
    if (!box) return false;
    if (video.src !== source) video.src = source;
    const rect = button.getBoundingClientRect();
    const viewportWidth = globalThis.innerWidth || 0;
    const viewportHeight = globalThis.innerHeight || 0;
    const width = Math.min(260, Math.max(180, Math.min(rect.width, viewportWidth - 16 || 260)));
    const height = width * 9 / 16;
    // Beside the card when there is room (cards sit in a side dock), so the
    // other choices stay visible; otherwise above it.
    let left, top;
    if (rect.left >= width + 20) {
      left = rect.left - width - 12;
      top = Math.min(Math.max(8, rect.bottom - height), Math.max(8, viewportHeight - height - 8));
    } else {
      left = Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), Math.max(8, viewportWidth - width - 8));
      top = Math.max(8, rect.top - height - 10);
    }
    box.style.width = `${width}px`;
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    box.classList.remove('hidden');
    owner = button;
    try {
      video.currentTime = range.start;
      const played = video.play();
      played?.catch?.(() => {});
    } catch { /* ignore */ }
    return true;
  };
  const attach = (button, start, end) => {
    if (!button || button.dataset.previewBound === 'true') return;
    button.dataset.previewBound = 'true';
    let held = false;
    button.addEventListener('pointerenter', event => {
      if (event.pointerType !== 'mouse') return;
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => show(button, start, end), HOVER_DELAY);
    });
    button.addEventListener('pointerleave', () => { if (owner === button || hoverTimer) hide(); });
    button.addEventListener('touchstart', () => {
      held = false;
      clearTimeout(holdTimer);
      holdTimer = setTimeout(() => { held = show(button, start, end); }, HOLD_DELAY);
    }, { passive: true });
    const release = () => { clearTimeout(holdTimer); if (owner === button) hide(); };
    button.addEventListener('touchend', release, { passive: true });
    button.addEventListener('touchcancel', release, { passive: true });
    button.addEventListener('touchmove', release, { passive: true });
    // A long press only previews; its trailing click must not select.
    button.addEventListener('click', event => {
      if (!held) { hide(); return; }
      held = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
    button.addEventListener('contextmenu', event => { if (held || holdTimer) event.preventDefault(); });
  };
  return { attach, hide };
}
