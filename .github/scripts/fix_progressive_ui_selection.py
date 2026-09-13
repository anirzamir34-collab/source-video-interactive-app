from pathlib import Path

p = Path('public/app.js')
s = p.read_text()
old = """  const selectionToken = beginAdultSelection();\n  state.activeAdultPreludeId = null;\n  const changedPosition = state.activePositionId !== position.id;"""
new = """  const selectionToken = shouldSeek\n    ? beginAdultSelection()\n    : state.adultSelectionToken;\n  if (shouldSeek) state.activeAdultPreludeId = null;\n  const changedPosition = state.activePositionId !== position.id;"""
if old not in s:
    raise SystemExit('selection anchor missing')
s = s.replace(old, new, 1)
p.write_text(s)
