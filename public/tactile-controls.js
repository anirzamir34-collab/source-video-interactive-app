const STORAGE_KEY = 'videoquest:tactile-feedback-v1';

// The Vibration API only knows on/off. Splitting a pulse into 20 ms cycles
// and varying the on-time emulates intensity (pulse-width modulation, as in
// the open-source WebHaptics library), which makes a light tick and a heavy
// thump feel clearly different on phones such as the Galaxy S series.
const PWM_CYCLE = 20;
export function pwm(duration, intensity = 1) {
  const total = Math.max(1, Math.round(Number(duration) || 0));
  const level = Math.max(0, Math.min(1, Number(intensity) || 0));
  if (level >= 1) return [total];
  if (level <= 0) return [];
  const out = [];
  for (let left = total; left > 0; left -= PWM_CYCLE) {
    const span = Math.min(PWM_CYCLE, left);
    const on = Math.max(1, Math.round(span * level));
    // Phone motors cannot render a 1–4 ms sliver; it only adds buzz noise.
    if (out.length && on < 5) break;
    out.push(on);
    if (span - on > 0) out.push(span - on);
  }
  // A pattern must end on a vibration so patterns can be joined with gaps.
  if (out.length % 2 === 0) out.pop();
  return out;
}
const join = (...parts) => parts.flatMap((part, index) =>
  typeof part === 'number' ? (index ? [part] : []) : part);

// Calm by default: one soft touch per choice. Only fast/intense source
// moments answer with a short rhythm, so strong feedback stays meaningful.
export const TACTILE_PATTERNS = Object.freeze({
  press: pwm(10, .5),                                    // SEKS hold start only
  selection: pwm(10, .6),                                // tab
  soft: pwm(16, .6),                                     // ordinary card
  confirm: pwm(18, .7),                                  // story choice
  impact: pwm(22, .8),                                   // intimate card, calm tempo
  charged: join(pwm(12, .6), 60, pwm(20, .85)),
  unavailable: join(pwm(10, .6), 50, pwm(10, .6)),
  complete: join(pwm(16, .7), 60, pwm(22, .85)),
  heartbeat: join(pwm(22, .8), 110, pwm(16, .55)),
  unlock: join(pwm(30, .8), 140, pwm(24, .6))
});

// Fast and intense tempos get a short pulse train; calmer tempos stay one touch.
const RHYTHM = { fast: [2, 230, .8], intense: [3, 180, .95] };
export const isIntenseTempo = tempo => Boolean(RHYTHM[String(tempo || '').toLowerCase()]);
export function rhythmPattern(tempo = 'moderate') {
  const row = RHYTHM[String(tempo || '').toLowerCase()];
  if (!row) return TACTILE_PATTERNS.impact;
  const [count, period, level] = row;
  const beat = Math.round(Math.min(40, period * .2));
  const parts = [];
  for (let index = 0; index < count; index += 1) {
    if (index) parts.push(period - beat);
    parts.push(pwm(beat, level));
  }
  return join(...parts);
}

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
      const selected = Array.isArray(kind) ? kind : TACTILE_PATTERNS[kind] ?? TACTILE_PATTERNS.press;
      const pattern = reducedMotion() && Array.isArray(selected) ? selected[0] : selected;
      try { return navigatorRef.vibrate(pattern) !== false; } catch { return false; }
    },
    rhythm(tempo) {
      if (reducedMotion() || !isIntenseTempo(tempo)) return this.pulse('impact');
      return this.pulse(rhythmPattern(tempo));
    }
  };
}

export function attachTactileSurface({
  root,
  engine,
  selector = 'button:not([data-tactile-managed])',
  stage = null
} = {}) {
  if (!root || !engine) return () => {};
  // What the button does decides how it feels: intimate cards thud, tabs
  // click, ordinary choices give a firm confirm.
  const feelFor = button => {
    const cls = button.classList;
    if (cls?.contains?.('position-tab') || cls?.contains?.('category-tab')) return 'selection';
    if (cls?.contains?.('movement-choice-card') || cls?.contains?.('approach-card')) return 'impact';
    return 'confirm';
  };
  const restart = (element, name, ms) => {
    if (!element?.classList) return;
    element.classList.remove(name);
    void element.offsetWidth; // restart the CSS animation on rapid taps
    element.classList.add(name);
    clearTimeout(element[`__${name}`]);
    element[`__${name}`] = setTimeout(() => element.classList.remove(name), ms);
  };
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
    // No vibration on touch-down: one calm touch on release is enough.
    button.classList.add('is-pressed');
    // The ripple starts exactly under the finger.
    const box = button.getBoundingClientRect?.();
    if (box && button.style?.setProperty) {
      button.style.setProperty('--vq-rx', `${Math.round(event.clientX - box.left)}px`);
      button.style.setProperty('--vq-ry', `${Math.round(event.clientY - box.top)}px`);
    }
    restart(button, 'vq-ripple', 520);
    try { button.setPointerCapture?.(event.pointerId); } catch { /* optional */ }
  };
  const onPointerUp = event => clear(event.pointerId);
  const onPointerCancel = event => clear(event.pointerId, true);
  const onClick = event => {
    const button = targetFor(event.target);
    if (!button || button.disabled) return;
    const feel = feelFor(button);
    const intense = feel === 'impact' && isIntenseTempo(button.dataset?.tempo);
    // Only a fast/intense real movement answers with a rhythm and the scene glow.
    if (intense && typeof engine.rhythm === 'function') engine.rhythm(button.dataset.tempo);
    else engine.pulse(feel === 'impact' ? 'impact' : feel === 'selection' ? 'selection' : 'confirm');
    button.classList.remove('tap-confirmed');
    requestAnimationFrame(() => button.classList.add('tap-confirmed'));
    if (feel !== 'selection') restart(stage, intense ? 'vq-impact' : 'vq-confirm', 650);
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
  if (!button || !engine || typeof onActivate !== 'function') {
    const detach = () => {};
    detach.reset = () => {};
    return detach;
  }
  let pointerId = null;
  let holdTimer = null;
  let charged = false;
  let resetVersion = 0;
  const clearTimer = () => {
    clearTimeout(holdTimer);
    holdTimer = null;
  };
  const reset = () => {
    const previousPointerId = pointerId;
    // Invalidate first: releasing capture can synchronously dispatch a lost
    // capture event, which must not reactivate or vibrate for an old scope.
    pointerId = null;
    charged = false;
    resetVersion += 1;
    clearTimer();
    button.classList.remove('is-pressed', 'is-charged', 'tap-confirmed');
    if (previousPointerId !== null) {
      try {
        if (!button.hasPointerCapture || button.hasPointerCapture(previousPointerId)) {
          button.releasePointerCapture?.(previousPointerId);
        }
      } catch { /* capture may already have been released by the browser */ }
    }
  };
  const activate = timestamp => {
    const wasCharged = charged;
    reset();
    const activationVersion = resetVersion;
    const accepted = onActivate({ charged: wasCharged, timestamp }) !== false;
    // A selection callback can switch scope and reset this controller. Its
    // confirmation must not appear on the newly selected scope afterwards.
    if (activationVersion !== resetVersion) return;
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
    if (button.disabled) { reset(); return; }
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
  const detach = () => {
    reset();
    delete button.dataset.tactileManaged;
    button.removeEventListener('pointerdown', onPointerDown);
    button.removeEventListener('pointerup', onPointerUp);
    button.removeEventListener('pointercancel', onPointerCancel);
    button.removeEventListener('lostpointercapture', onPointerCancel);
    button.removeEventListener('click', onClick);
  };
  detach.reset = reset;
  return detach;
}
