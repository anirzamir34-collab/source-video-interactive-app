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

export function syncInteractionSurfaces({ panel, overlay, panelVisible = false,
  overlayVisible = false } = {}) {
  const showPanel = Boolean(panel && panelVisible);
  // Dedicated controls and ordinary choices have a single visible owner. A
  // repeated seek/pause render updates the same nodes instead of remounting.
  const showOverlay = Boolean(overlay && overlayVisible && !showPanel);
  panel?.classList.toggle('hidden', !showPanel);
  overlay?.classList.toggle('hidden', !showOverlay);
  return { panelVisible: showPanel, overlayVisible: showOverlay,
    overlayCount: Number(showPanel) + Number(showOverlay) };
}
