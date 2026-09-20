const STORAGE_KEY = 'videoquest:tactile-feedback-v1';

export const TACTILE_PATTERNS = Object.freeze({
  press: 9,
  confirm: [12, 18, 20],
  charged: [10, 18, 28],
  unavailable: [6, 34, 6],
  complete: [8, 16, 12]
});

function readEnabled(storage) {
  try {
    return storage?.getItem(STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function createTactileEngine({
  navigatorRef = globalThis.navigator,
  storage = globalThis.localStorage,
  matchMediaRef = globalThis.matchMedia
} = {}) {
  let enabled = readEnabled(storage);
  const reducedMotion = () => Boolean(matchMediaRef?.('(prefers-reduced-motion: reduce)')?.matches);
  const supported = () => typeof navigatorRef?.vibrate === 'function';
  const persist = () => {
    try { storage?.setItem(STORAGE_KEY, enabled ? 'on' : 'off'); } catch { /* optional */ }
  };

  return {
    get enabled() { return enabled; },
    get supported() { return supported(); },
    setEnabled(value) {
      enabled = Boolean(value);
      persist();
      return enabled;
    },
    toggle() {
      enabled = !enabled;
      persist();
      return enabled;
    },
    pulse(kind = 'press') {
      if (!enabled || !supported()) return false;
      const selected = TACTILE_PATTERNS[kind] ?? TACTILE_PATTERNS.press;
      const pattern = reducedMotion() && Array.isArray(selected) ? selected[0] : selected;
      try { return navigatorRef.vibrate(pattern) !== false; } catch { return false; }
    }
  };
}

export function attachTactileSurface({
  root,
  engine,
  selector = 'button:not([data-tactile-managed])'
} = {}) {
  if (!root || !engine) return () => {};
  const pressedPointers = new Map();
  const targetFor = target => target?.closest?.(selector);
  const clear = (pointerId, cancelled = false) => {
    const button = pressedPointers.get(pointerId);
    if (!button) return;
    pressedPointers.delete(pointerId);
    button.classList.remove('is-pressed');
    if (cancelled) button.classList.add('press-cancelled');
    if (cancelled) setTimeout(() => button.classList.remove('press-cancelled'), 160);
  };
  const onPointerDown = event => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const button = targetFor(event.target);
    if (!button || button.disabled) return;
    pressedPointers.set(event.pointerId, button);
    button.classList.add('is-pressed');
    try { button.setPointerCapture?.(event.pointerId); } catch { /* optional */ }
    engine.pulse('press');
  };
  const onPointerUp = event => clear(event.pointerId);
  const onPointerCancel = event => clear(event.pointerId, true);
  const onClick = event => {
    const button = targetFor(event.target);
    if (!button || button.disabled) return;
    engine.pulse('confirm');
    button.classList.remove('tap-confirmed');
    requestAnimationFrame(() => button.classList.add('tap-confirmed'));
  };

  root.addEventListener('pointerdown', onPointerDown, true);
  root.addEventListener('pointerup', onPointerUp, true);
  root.addEventListener('pointercancel', onPointerCancel, true);
  root.addEventListener('lostpointercapture', onPointerCancel, true);
  root.addEventListener('click', onClick, true);
  return () => {
    root.removeEventListener('pointerdown', onPointerDown, true);
    root.removeEventListener('pointerup', onPointerUp, true);
    root.removeEventListener('pointercancel', onPointerCancel, true);
    root.removeEventListener('lostpointercapture', onPointerCancel, true);
    root.removeEventListener('click', onClick, true);
  };
}

export function attachHoldReleaseControl({ button, engine, onActivate, holdMs = 460 } = {}) {
  if (!button || !engine || typeof onActivate !== 'function') return () => {};
  let pointerId = null;
  let holdTimer = null;
  let charged = false;
  const clearTimer = () => {
    clearTimeout(holdTimer);
    holdTimer = null;
  };
  const reset = () => {
    clearTimer();
    button.classList.remove('is-pressed', 'is-charged');
    pointerId = null;
    charged = false;
  };
  const activate = timestamp => {
    const wasCharged = charged;
    reset();
    const accepted = onActivate({ charged: wasCharged, timestamp }) !== false;
    engine.pulse(accepted ? (wasCharged ? 'charged' : 'confirm') : 'unavailable');
    button.classList.toggle('tap-confirmed', accepted);
  };
  const onPointerDown = event => {
    if (button.disabled || pointerId !== null || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.preventDefault();
    pointerId = event.pointerId;
    button.classList.add('is-pressed');
    engine.pulse('press');
    try { button.setPointerCapture?.(pointerId); } catch { /* optional */ }
    holdTimer = setTimeout(() => {
      if (pointerId === null || button.disabled) return;
      charged = true;
      button.classList.add('is-charged');
      engine.pulse('charged');
    }, holdMs);
  };
  const onPointerUp = event => {
    if (event.pointerId !== pointerId) return;
    event.preventDefault();
    activate(event.timeStamp);
  };
  const onPointerCancel = event => {
    if (event.pointerId !== pointerId) return;
    reset();
    engine.pulse('unavailable');
  };
  const onClick = event => {
    event.preventDefault();
    if (event.detail === 0 && pointerId === null && !button.disabled) activate(performance.now());
  };

  button.dataset.tactileManaged = 'true';
  button.addEventListener('pointerdown', onPointerDown);
  button.addEventListener('pointerup', onPointerUp);
  button.addEventListener('pointercancel', onPointerCancel);
  button.addEventListener('lostpointercapture', onPointerCancel);
  button.addEventListener('click', onClick);
  return () => {
    reset();
    delete button.dataset.tactileManaged;
    button.removeEventListener('pointerdown', onPointerDown);
    button.removeEventListener('pointerup', onPointerUp);
    button.removeEventListener('pointercancel', onPointerCancel);
    button.removeEventListener('lostpointercapture', onPointerCancel);
    button.removeEventListener('click', onClick);
  };
}
