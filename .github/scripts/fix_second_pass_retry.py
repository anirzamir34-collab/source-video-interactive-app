from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: expected 1 match, got {count}')
    return text.replace(old, new, 1)

app_path = Path('public/app.js')
app = app_path.read_text()
app = replace_once(
    app,
    """      for (let attempt = 1; attempt <= 3 && !chunkSucceeded; attempt += 1) {
        els.analysisOutput.textContent =
          `${chunkStart.toFixed(1)}–${chunkEnd.toFixed(1)} saniye ayrıntılı inceleniyor...\\n` +
          `Deneme ${attempt}/3 · tamamlanan ${chunkResults.length}/${chunkCount}`;

        try {
""",
    """      for (let attempt = 1; attempt <= 3 && !chunkSucceeded; attempt += 1) {
        els.analysisOutput.textContent =
          `${chunkStart.toFixed(1)}–${chunkEnd.toFixed(1)} saniye ayrıntılı inceleniyor...\\n` +
          `Deneme ${attempt}/3 · tamamlanan ${chunkResults.length}/${chunkCount}`;

        // Every retry starts from a clean first pass. Review metadata is added
        // only after that first pass succeeds, so a failed review cannot poison
        // the next retry.
        form.delete('reviewMode');
        form.delete('reviewCandidates');

        try {
""",
    'reset review fields on retry'
)
app_path.write_text(app)

server_path = Path('server.js')
server = server_path.read_text()
server = replace_once(
    server,
    """        const minimum =
          type === 'outcome' || type === 'aftermath' || outcome === 'climax' || outcome === 'aftermath'
            ? 0.82
            : action.positionId || action.positionLabel || type === 'position'
              ? 0.72
              : action.adultScene
                ? 0.64
                : 0.52;
        return Number(action.confidence || 0) >= minimum;
""",
    """        const strictMinimum =
          type === 'outcome' || type === 'aftermath' || outcome === 'climax' || outcome === 'aftermath'
            ? 0.82
            : action.positionId || action.positionLabel || type === 'position'
              ? 0.72
              : action.adultScene
                ? 0.64
                : 0.52;
        // First pass is deliberately permissive enough to preserve uncertain
        // candidates for the visual review pass. Review mode applies the full
        // confidence threshold before a candidate can reach gameplay.
        const minimum = reviewMode
          ? strictMinimum
          : Math.max(0.4, strictMinimum - 0.18);
        return Number(action.confidence || 0) >= minimum;
""",
    'two-stage confidence gate'
)
server_path.write_text(server)

print('Second-pass retry and confidence staging fixed.')
