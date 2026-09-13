from pathlib import Path

path = Path('public/app.js')
text = path.read_text()
old = """  const file = state.selectedFile;
  const modes = selectedAnalysisModes();

  try {
"""
new = """  const file = state.selectedFile;
  const modes = selectedAnalysisModes();

  // Every analysis run must start from a clean dialogue/dub timeline.
  // Reusing old segment ids or old translated dialogue can attach stale audio
  // to new source-video timestamps after a re-analysis.
  state.dialogue = null;
  state.dubbingEnabled = false;
  state.subtitlesEnabled = false;
  resetDubState();
  els.video.muted = false;
  els.subtitleOverlay?.classList.add('hidden');

  try {
"""
count = text.count(old)
if count != 1:
    raise RuntimeError(f'analysis state reset anchor count={count}')
path.write_text(text.replace(old, new, 1))
