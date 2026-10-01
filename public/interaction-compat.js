// Legacy controls are views of one runtime. No source labels or roles are
// inferred here; bindings only adapt field names and numeric units.
export function bindInteractionRuntimeViews(host, {
  runtimeKey = 'interactionRuntime', progressKey, progressTarget = 100,
  unlockedKey, revealedKey, activeKeys = {}, unlockedFlagKey
} = {}) {
  if (host.interactionRuntimeViewsBound) return;
  const initial = {};
  const keys = [progressKey, unlockedKey, revealedKey, unlockedFlagKey, ...Object.keys(activeKeys)].filter(Boolean);
  for (const key of keys) initial[key] = host[key];
  const runtime = () => host[runtimeKey];
  const write = patch => { if (runtime()) host[runtimeKey] = { ...runtime(), ...patch }; };
  const define = (key, get, set) => {
    if (key) Object.defineProperty(host, key, { enumerable: true, configurable: true, get, set });
  };
  define(progressKey,
    () => runtime() ? Math.min(100, Math.max(0, Number(runtime().progressionValue) || 0)) * progressTarget / 100 : initial[progressKey] || 0,
    value => {
      const raw = Math.min(progressTarget, Math.max(0, Number(value) || 0));
      initial[progressKey] = raw;
      write({ progressionValue: raw * 100 / progressTarget });
    });
  const bindIds = (key, field) => define(key, () => {
    const ownerScene = runtime()?.scene;
    const ownsScene = () => runtime()?.scene === ownerScene;
    const liveIds = () => runtime()?.[field] || [...(initial[key] || [])];
    const view = new Set(liveIds());
    const commit = values => {
      if (!ownsScene()) return;
      initial[key] = new Set(values);
      write({ [field]: [...values] });
    };
    // A caller may retain a view during a render. Mutation always reads the
    // latest runtime array, so a stale render cannot discard a newer unlock.
    view.add = id => { const values = new Set(liveIds()); values.add(id); commit(values); Set.prototype.add.call(view, id); return view; };
    view.delete = id => { const values = new Set(liveIds()); const removed = values.delete(id); commit(values); Set.prototype.delete.call(view, id); return removed; };
    view.clear = () => { commit([]); Set.prototype.clear.call(view); };
    return view;
  }, values => {
    initial[key] = new Set(values || []);
    write({ [field]: [...initial[key]] });
  });
  if (unlockedKey) bindIds(unlockedKey, 'unlockedGroupIds');
  if (revealedKey) bindIds(revealedKey, 'revealedGroupIds');
  for (const [key, field] of Object.entries(activeKeys)) define(key,
    () => runtime() ? runtime()[field] ?? null : initial[key] ?? null,
    value => { initial[key] = value ?? null; write({ [field]: value ?? null }); });
  define(unlockedFlagKey, () => runtime()
    ? (runtime().scene?.groups || []).some(group => group.phase === 'CORE' && group.sourceVerified === true &&
      runtime().unlockedGroupIds.includes(group.id)) : Boolean(initial[unlockedFlagKey]),
  value => { initial[unlockedFlagKey] = Boolean(value); });
  host.interactionRuntimeViewsBound = true;
}
