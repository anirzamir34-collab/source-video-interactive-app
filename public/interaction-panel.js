// Content-independent panel lifecycle. These helpers never alter source data,
// media time, unlock state, or labels.

export function mountInteractionPanel(stage, panel) {
  if (!stage || !panel) return { mounted: false, removedDuplicates: 0 };
  let removedDuplicates = 0;
  // A panel has one stable DOM identity. Remove only duplicate instances of
  // that exact identity; unrelated overlays remain owned by their controllers.
  if (panel.id) {
    const root = stage.ownerDocument || stage;
    for (const node of root.querySelectorAll?.('[id]') || []) {
      if (node !== panel && node.id === panel.id) {
        node.remove();
        removedDuplicates += 1;
      }
    }
  }
  const mounted = panel.parentElement !== stage;
  if (mounted) stage.appendChild(panel);
  return { mounted, removedDuplicates };
}

export function resetInteractionSelection(state, {
  selectionKeys = ['activeGroupId', 'activeOccurrenceId', 'activeMovementId',
    'activeMovementChoiceId', 'activeApproachId', 'pendingSelection'],
  rhythmDefaults = { tapTimes: [], tapTempo: 'unclear', tapCandidateTempo: 'unclear',
    tapCandidateCount: 0, lastTempoSwitchAt: 0, held: false, armed: false,
    awaitingInput: false }
} = {}) {
  if (!state) return;
  for (const key of selectionKeys) state[key] = null;
  for (const [key, value] of Object.entries(rhythmDefaults)) {
    state[key] = Array.isArray(value) ? [...value]
      : value instanceof Set ? new Set(value)
      : value instanceof Map ? new Map(value) : value;
  }
}

// Exactly one controller owns the visible gameplay surface. The renderer
// selects a named surface after producing its cards; CSS and fullscreen never
// guess a different phase or expose a stale, empty panel.
export const INTERACTION_SURFACES = Object.freeze(['none', 'story', 'approach', 'panel']);

export function syncInteractionSurfaces({ panel, overlay, approach, surface = 'none' } = {}) {
  if (!INTERACTION_SURFACES.includes(surface)) throw new RangeError('UNKNOWN_INTERACTION_SURFACE');
  const targets = { panel, story: overlay, approach };
  const visible = surface !== 'none' && targets[surface] ? surface : 'none';
  const panelVisible = visible === 'panel';
  const overlayVisible = visible === 'story';
  const approachVisible = visible === 'approach';
  panel?.classList.toggle('hidden', !panelVisible);
  overlay?.classList.toggle('hidden', !overlayVisible);
  approach?.classList.toggle('hidden', !approachVisible);
  return { surface: visible, panelVisible, overlayVisible, approachVisible,
    overlayCount: Number(panelVisible) + Number(overlayVisible) + Number(approachVisible) };
}

// Source playback owns the surface. An old interaction controller must never
// remain actionable over a subsequent unrelated scene or a manual seek.
export function sceneSurfaceIsStale(scene, mediaTime, tolerance = 0.15) {
  const start = Number(scene?.startTime), end = Number(scene?.endTime);
  const now = Number(mediaTime);
  if (!scene || !Number.isFinite(start) || !Number.isFinite(end) || end <= start ||
      !Number.isFinite(now)) return false;
  return now < start - tolerance || now >= end + tolerance;
}
