// Timed decisions: at a decision the video waits a few seconds; without a
// choice it simply continues with its own next part ("videonun akışı"), like
// an interactive film. The other cards say how far ahead they jump, so no
// option pretends to be an alternative it is not.

export const DECISION_SECONDS = 8;
const PREF_KEY = 'vq.autoContinue';

export function autoContinueEnabled(storage = globalThis.localStorage) {
  try { return storage?.getItem?.(PREF_KEY) !== 'off'; } catch { return true; }
}
export function setAutoContinue(enabled, storage = globalThis.localStorage) {
  try { storage?.setItem?.(PREF_KEY, enabled ? 'on' : 'off'); } catch { /* per-viewer convenience only */ }
}

// The card that continues the source video is the one that starts first.
export function choiceRoles(candidates = []) {
  const list = (Array.isArray(candidates) ? candidates : []).filter(Boolean);
  if (!list.length) return new Map();
  const flow = list.reduce((best, item) => Number(item.startTime) < Number(best.startTime) ? item : best, list[0]);
  const flowStart = Number(flow.startTime);
  return new Map(list.map(item => {
    const ahead = Number(item.startTime) - flowStart;
    if (item === flow) return [item, { role: 'flow', ahead: 0 }];
    // Two genuine alternatives at the same instant are both real options.
    if (ahead <= 1) return [item, { role: 'alternative', ahead: 0 }];
    return [item, { role: 'jump', ahead: Math.round(ahead) }];
  }));
}

export function roleCaption(meta) {
  if (!meta) return '';
  if (meta.role === 'flow') return 'Videonun akışı';
  if (meta.role === 'jump') return `İleri atla · +${meta.ahead} sn`;
  return '';
}

// One countdown at a time; every new decision or any choice cancels it.
export function createDecisionTimer({ seconds = DECISION_SECONDS, setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout, setTick = globalThis.setInterval, clearTick = globalThis.clearInterval } = {}) {
  let timer = null, ticker = null, token = 0;
  const cancel = () => {
    token += 1;
    if (timer !== null) clearTimer(timer);
    if (ticker !== null) clearTick(ticker);
    timer = null; ticker = null;
  };
  const start = ({ onExpire, onTick, isStillValid = () => true } = {}) => {
    cancel();
    const mine = token;
    let left = seconds;
    onTick?.(left);
    ticker = setTick(() => {
      if (mine !== token) return;
      left = Math.max(0, left - 1);
      onTick?.(left);
    }, 1000);
    timer = setTimer(() => {
      if (mine !== token) return;
      cancel();
      if (isStillValid()) onExpire?.();
    }, seconds * 1000);
    return mine;
  };
  return { start, cancel, get active() { return timer !== null; } };
}
