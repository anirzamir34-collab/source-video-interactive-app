from pathlib import Path

path = Path('server.js')
text = path.read_text()
old = "    files: 20,\n    fields: 10"
new = "    files: 20,\n    fields: 14"
if text.count(old) != 1:
    raise RuntimeError(f'Expected one storyboard field-limit match, got {text.count(old)}')
path.write_text(text.replace(old, new, 1))
