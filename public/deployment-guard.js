// Keep an already open player from starting a new analysis with a module graph
// loaded before the latest deployment. A network failure must not block play.
export function createDeploymentGuard({ fetch = globalThis.fetch } = {}) {
  const readCommit = async () => {
    const response = await fetch('/health', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!response.ok) return '';
    return String((await response.json()).deploymentCommit || '').trim();
  };
  const loaded = readCommit().catch(() => '');
  return {
    loadedCommit: () => loaded,
    async hasChanged() {
      const original = await loaded;
      if (!original) return false;
      try {
        const current = await readCommit();
        return Boolean(current && current !== original);
      } catch { return false; }
    }
  };
}
