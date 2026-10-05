// Fullscreen failures never pause the source or replace its current choices.
export async function toggleFullscreen({ document, stage, screen, status }) {
  if (status) { status.hidden = true; status.classList.remove('hidden'); status.textContent = ''; }
  try {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (!exit) throw Error('Fullscreen exit is unavailable');
      await exit.call(document);
      try { await screen?.orientation?.unlock?.(); } catch {}
    } else {
      const enter = stage?.requestFullscreen || stage?.webkitRequestFullscreen;
      if (!enter) throw Error('Fullscreen is unavailable');
      await enter.call(stage);
      try { await screen?.orientation?.lock?.('landscape'); } catch {}
    }
    return true;
  } catch {
    if (status) {
      status.textContent = 'Tam ekran açılamadı. Videoyu bu ekranda kullanabilirsin.';
      status.hidden = false;
    }
    return false;
  }
}

// The compact dock can be useful in the embedded player, but entering
// fullscreen should expose the complete set of source-backed choices.
export function revealFullscreenChoices({ document, stage, panel, expand }) {
  const active = document?.fullscreenElement === stage || document?.webkitFullscreenElement === stage;
  if (!active || !panel || panel.classList.contains('hidden')) return false;
  expand?.();
  return true;
}
