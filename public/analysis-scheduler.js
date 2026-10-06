// The first chapter establishes the stable protagonist and story context.
// Later independent chapters can be reviewed in small concurrent batches;
// each batch gets one immutable snapshot of already completed earlier work.
export async function runContextualAnalysisChunks(count, {
  concurrency = 2, context, analyze, afterBatch
} = {}) {
  const total = Math.max(0, Math.floor(Number(count) || 0));
  const parallel = Math.max(1, Math.min(3, Math.floor(Number(concurrency) || 1)));
  for (let start = 0; start < total;) {
    const width = start === 0 ? 1 : Math.min(parallel, total - start);
    const snapshot = context(start);
    const results = await Promise.all(Array.from({ length: width }, (_, offset) =>
      analyze(start + offset, snapshot)));
    await afterBatch?.(results);
    const failure = results.find(result => result?.failureBody);
    if (failure) return failure;
    start += width;
  }
  return null;
}
