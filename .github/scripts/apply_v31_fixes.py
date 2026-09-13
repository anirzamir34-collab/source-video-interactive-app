from pathlib import Path
import re


def sub_once(text, pattern, replacement, label, flags=0):
    updated, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise RuntimeError(f"{label}: expected one replacement, got {count}")
    return updated


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one exact match, got {count}")
    return text.replace(old, new, 1)


# ---------- public/adult-gameplay.js ----------
gameplay_path = Path('public/adult-gameplay.js')
gameplay = gameplay_path.read_text()

gameplay = sub_once(
    gameplay,
    r"export function adultDiscoveryPhase\(\{.*?\n\}\n\nexport function computeWarmupSelectionDelta",
    '''export const ADULT_PHASE_ORDER = Object.freeze({
  foreplay: 0,
  positions: 1,
  reward: 2,
  final: 3
});

export function adultDiscoveryPhase({
  hasCoreUnlocked = false,
  hasBonusUnlocked = false,
  hasOutcomeUnlocked = false
} = {}) {
  if (hasOutcomeUnlocked) return 'final';
  if (hasBonusUnlocked) return 'reward';
  if (hasCoreUnlocked) return 'positions';
  return 'foreplay';
}

export function requiredWarmupDiscoveries(totalChoices = 0) {
  const total = Math.max(0, Math.floor(Number(totalChoices) || 0));
  if (!total) return 0;
  return Math.min(total, Math.max(1, Math.ceil(total * 0.7)));
}

export function canUnlockCorePositions({
  flow = 0,
  warmupTotal = 0,
  warmupUniquePlayed = 0
} = {}) {
  const total = Math.max(0, Math.floor(Number(warmupTotal) || 0));
  if (!total) return true;
  const played = Math.max(0, Math.floor(Number(warmupUniquePlayed) || 0));
  return clamp(flow, 0, 100) >= DEFAULT_POSITION_UNLOCK_PROGRESS &&
    played >= requiredWarmupDiscoveries(total);
}

export function canUnlockBonusPositions({
  flow = 0,
  coreVisitedCount = 0,
  corePositionCount = 0,
  bootstrap = false
} = {}) {
  if (bootstrap) return true;
  const coreCount = Math.max(0, Math.floor(Number(corePositionCount) || 0));
  const visited = Math.max(0, Math.floor(Number(coreVisitedCount) || 0));
  return clamp(flow, 0, 100) >= DEFAULT_BONUS_UNLOCK_PROGRESS &&
    (coreCount === 0 || visited >= 1);
}

export function monotonicAdultPhase(proposed = 'foreplay', previous = 'foreplay') {
  const proposedRank = ADULT_PHASE_ORDER[proposed] ?? 0;
  const previousRank = ADULT_PHASE_ORDER[previous] ?? 0;
  return proposedRank >= previousRank ? proposed : previous;
}

export function computeWarmupSelectionDelta''',
    'replace discovery phase and add gating helpers',
    flags=re.S
)

gameplay_path.write_text(gameplay)


# ---------- test/adult-gameplay.test.js ----------
test_path = Path('test/adult-gameplay.test.js')
test_text = test_path.read_text()

test_text = replace_once(
    test_text,
    "  averageAdultProgress,\n  computeAdultSelectionDelta,\n  isOutcomeUnlocked,\n  normalizeOutcomeUnlockProgress,\n  pickNextVariant\n",
    "  adultDiscoveryPhase,\n  averageAdultProgress,\n  canUnlockBonusPositions,\n  canUnlockCorePositions,\n  computeAdultSelectionDelta,\n  isOutcomeUnlocked,\n  monotonicAdultPhase,\n  normalizeOutcomeUnlockProgress,\n  pickNextVariant,\n  requiredWarmupDiscoveries\n",
    'extend gameplay test imports'
)

test_text += '''\n\ntest('core positions wait for both Lust and enough unique warm-up discovery', () => {
  assert.equal(requiredWarmupDiscoveries(8), 6);
  assert.equal(canUnlockCorePositions({ flow: 50, warmupTotal: 8, warmupUniquePlayed: 5 }), false);
  assert.equal(canUnlockCorePositions({ flow: 34, warmupTotal: 8, warmupUniquePlayed: 8 }), false);
  assert.equal(canUnlockCorePositions({ flow: 50, warmupTotal: 8, warmupUniquePlayed: 6 }), true);
  assert.equal(canUnlockCorePositions({ flow: 0, warmupTotal: 0, warmupUniquePlayed: 0 }), true);
});

test('bonus positions require reward-level Lust and at least one core visit when core positions exist', () => {
  assert.equal(canUnlockBonusPositions({ flow: 80, coreVisitedCount: 0, corePositionCount: 3 }), false);
  assert.equal(canUnlockBonusPositions({ flow: 71, coreVisitedCount: 2, corePositionCount: 3 }), false);
  assert.equal(canUnlockBonusPositions({ flow: 80, coreVisitedCount: 1, corePositionCount: 3 }), true);
  assert.equal(canUnlockBonusPositions({ flow: 0, coreVisitedCount: 0, corePositionCount: 0, bootstrap: true }), true);
});

test('discovery phases are content-driven and never regress once a later phase was reached', () => {
  assert.equal(adultDiscoveryPhase({ flow: 99 }), 'foreplay');
  assert.equal(adultDiscoveryPhase({ hasCoreUnlocked: true }), 'positions');
  assert.equal(adultDiscoveryPhase({ hasCoreUnlocked: true, hasBonusUnlocked: true }), 'reward');
  assert.equal(monotonicAdultPhase('foreplay', 'positions'), 'positions');
  assert.equal(monotonicAdultPhase('positions', 'reward'), 'reward');
});
'''

test_path.write_text(test_text)


# ---------- public/app.js ----------
app_path = Path('public/app.js')
app = app_path.read_text()

app = replace_once(
    app,
    "  averageAdultProgress,\n  computeAdultSelectionDelta,\n  computeWarmupSelectionDelta,\n  isOutcomeUnlocked,\n  normalizeOutcomeUnlockProgress,\n  pickNextVariant,\n  positionUnlockProgress\n",
    "  averageAdultProgress,\n  canUnlockBonusPositions,\n  canUnlockCorePositions,\n  computeAdultSelectionDelta,\n  computeWarmupSelectionDelta,\n  isOutcomeUnlocked,\n  monotonicAdultPhase,\n  normalizeOutcomeUnlockProgress,\n  pickNextVariant,\n  positionUnlockProgress,\n  requiredWarmupDiscoveries\n",
    'extend app gameplay imports'
)

app = replace_once(
    app,
    "  dubCache: new Map(),\n  dubRequests: new Map(),\n",
    "  dubCache: new Map(),\n  dubRequests: new Map(),\n  dubSyncGeneration: 0,\n",
    'add dub generation state'
)

app = replace_once(
    app,
    "  state.dubCache.clear();\n  state.dubRequests.clear();\n  state.activeDubSegmentId = null;\n}",
    "  state.dubCache.clear();\n  state.dubRequests.clear();\n  state.dubSyncGeneration += 1;\n  state.activeDubSegmentId = null;\n}",
    'invalidate dub generation on reset'
)

app = sub_once(
    app,
    r"async function syncDubPlayback\(\) \{.*?\n\}\n\nels\.video\.addEventListener\('timeupdate',syncDubPlayback\);\nels\.video\.addEventListener\('pause',\(\)=>dubAudio\.pause\(\)\);\nels\.video\.addEventListener\('seeking',\(\)=>\{.*?\n\}\);\nels\.video\.addEventListener\('play',syncDubPlayback\);",
    '''function prefetchDubAround(videoTime) {
  if (!state.dubbingEnabled) return;
  const current = getDubBlockAt(videoTime);
  if (current) void ensureDubBlock(current);

  const nextTime = current
    ? current.blockEnd + 0.01
    : Math.max(0, Number(videoTime) || 0) + DUB_BLOCK_SECONDS;
  const next = getDubBlockAt(nextTime);
  if (next && (!current || next.blockId !== current.blockId)) {
    void ensureDubBlock(next);
  }
}

async function syncDubPlayback() {
  if (!state.dubbingEnabled) return stopDubPlayback();

  const generation = state.dubSyncGeneration;
  const videoTime = Math.max(0, Number(els.video.currentTime) || 0);
  const block = getDubBlockAt(videoTime);
  if (!block) return stopDubPlayback();

  if (state.activeDubSegmentId === block.blockId && dubAudio.src) {
    const expected = Math.max(0, videoTime - block.blockStart);
    if (Number.isFinite(dubAudio.duration) && expected < dubAudio.duration &&
        Math.abs((Number(dubAudio.currentTime) || 0) - expected) > 0.45) {
      dubAudio.currentTime = expected;
    }
    dubAudio.playbackRate = Math.max(0.9, Math.min(1.1, Number(els.video.playbackRate) || 1));
    if (!els.video.paused && dubAudio.paused && expected < (dubAudio.duration || Infinity)) {
      dubAudio.play().catch(() => {});
    }
    prefetchDubAround(videoTime);
    return;
  }

  stopDubPlayback();
  const requestedId = block.blockId;
  const source = await ensureDubBlock(block);
  if (!source || !state.dubbingEnabled || generation !== state.dubSyncGeneration) return;

  const current = getDubBlockAt(Number(els.video.currentTime) || 0);
  if (!current || current.blockId !== requestedId) return;

  state.activeDubSegmentId = requestedId;
  dubAudio.src = source;
  dubAudio.load();

  const start = () => {
    if (
      !state.dubbingEnabled ||
      state.activeDubSegmentId !== requestedId ||
      generation !== state.dubSyncGeneration
    ) return;

    const expected = Math.max(0, (Number(els.video.currentTime) || 0) - block.blockStart);
    if (Number.isFinite(dubAudio.duration) && dubAudio.duration > 0) {
      dubAudio.currentTime = Math.min(Math.max(0, dubAudio.duration - 0.05), expected);
    }
    dubAudio.playbackRate = Math.max(0.9, Math.min(1.1, Number(els.video.playbackRate) || 1));
    if (!els.video.paused && expected < (dubAudio.duration || Infinity)) {
      dubAudio.play().catch(() => {});
    }
    prefetchDubAround(Number(els.video.currentTime) || 0);
  };

  if (dubAudio.readyState >= 1) start();
  else dubAudio.addEventListener('loadedmetadata', start, { once: true });
}

els.video.addEventListener('timeupdate', () => void syncDubPlayback());
els.video.addEventListener('pause', () => dubAudio.pause());
els.video.addEventListener('seeking', () => {
  state.dubSyncGeneration += 1;
  dubAudio.pause();
  state.activeDubSegmentId = null;
});
els.video.addEventListener('seeked', () => {
  if (!state.dubbingEnabled) return;
  void syncDubPlayback();
  prefetchDubAround(Number(els.video.currentTime) || 0);
});
els.video.addEventListener('play', () => {
  void syncDubPlayback();
  prefetchDubAround(Number(els.video.currentTime) || 0);
});''',
    'replace dub sync with seek-resilient sync',
    flags=re.S
)

app = sub_once(
    app,
    r"function canonicalAdultPosition\(action\) \{.*?\n\}\n\nfunction adultCategoryFor",
    '''function canonicalAdultPosition(action) {
  // Prefer human-readable visual evidence over a conflicting machine id.
  // This prevents a stale/wrong positionId from turning a visibly labelled
  // cowgirl segment into a missionary button (or the reverse).
  const family =
    adultSemanticFamily(action.positionLabel) ||
    adultSemanticFamily(action.label) ||
    adultSemanticFamily(action.positionId);

  const labels = {
    oral: 'Oral Seks',
    manual: 'Manuel Uyarım',
    missionary: 'Misyoner Pozisyonu',
    cowgirl: 'Kovboy Pozisyonu',
    spoon: 'Kaşık Pozisyonu',
    'standing-rear': 'Ayakta Arkadan Pozisyon',
    rear: 'Arkadan Pozisyon',
    standing: 'Ayakta Pozisyon'
  };

  if (family) return { id: family, label: labels[family] };

  const fallback = normalizeAdultLabel(
    action.positionLabel || action.positionId || action.label || 'pozisyon'
  ).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  return {
    id: fallback || `position-${Math.round(Number(action.startTime) || 0)}`,
    label: action.positionLabel || action.label || 'Pozisyon'
  };
}

function adultCategoryFor''',
    'make position label evidence authoritative',
    flags=re.S
)

merge_helper = '''\nconst ADULT_FRAGMENT_MERGE_GAP_SECONDS = 8;\n\nfunction mergeAdultSceneFragments(scenes) {\n  const sorted = [...(Array.isArray(scenes) ? scenes : [])]\n    .sort((a, b) => Number(a.startTime) - Number(b.startTime));\n  const merged = [];\n\n  for (const scene of sorted) {\n    const previous = merged[merged.length - 1];\n    if (!previous) {\n      merged.push({ ...scene });\n      continue;\n    }\n\n    const gap = Number(scene.startTime) - Number(previous.endTime);\n    if (gap > ADULT_FRAGMENT_MERGE_GAP_SECONDS) {\n      merged.push({ ...scene });\n      continue;\n    }\n\n    previous.startTime = Math.min(Number(previous.startTime), Number(scene.startTime));\n    previous.endTime = Math.max(Number(previous.endTime), Number(scene.endTime));\n    previous.postSceneTime = Math.max(Number(previous.postSceneTime), Number(scene.postSceneTime));\n    previous.foreplay = [...(previous.foreplay || []), ...(scene.foreplay || [])]\n      .sort((a, b) => Number(a.startTime) - Number(b.startTime));\n    previous.positions = [...(previous.positions || []), ...(scene.positions || [])]\n      .sort((a, b) => Number(a.startTime) - Number(b.startTime));\n    previous.outcomes = [...(previous.outcomes || []), ...(scene.outcomes || [])]\n      .sort((a, b) => Number(a.startTime) - Number(b.startTime));\n\n    if (!previous.aftermath || (scene.aftermath && Number(scene.aftermath.startTime) > Number(previous.aftermath.startTime))) {\n      previous.aftermath = scene.aftermath || previous.aftermath;\n    }\n  }\n\n  return merged;\n}\n'''

app = replace_once(
    app,
    "function prepareAdultScenes() {",
    merge_helper + "\nfunction prepareAdultScenes() {",
    'insert adult scene fragment merger'
)

app = replace_once(
    app,
    "    .filter(scene => scene.positions.length || scene.foreplay.length)\n    .sort((a, b) => a.startTime - b.startTime);\n\n  state.adultScenes.forEach(scene => {",
    "    .filter(scene => scene.positions.length || scene.foreplay.length)\n    .sort((a, b) => a.startTime - b.startTime);\n\n  state.adultScenes = mergeAdultSceneFragments(state.adultScenes);\n\n  state.adultScenes.forEach(scene => {",
    'merge adjacent adult fragments before numbering'
)

app = sub_once(
    app,
    r"function unlockedAdultPositions\(scene = state\.adultScene\) \{.*?\n\}\n\nfunction unlockedAdultOutcomes",
    '''function adultWarmupStats(scene = state.adultScene) {
  const warmupPositions = (scene?.positions || []).filter(isWarmupPosition);
  const warmupActionIds = new Set((scene?.foreplay || []).map(item => item.id));
  let warmupUniquePlayed = 0;

  warmupActionIds.forEach(id => {
    if (Number(state.adultPreludePlayCounts.get(id) || 0) > 0) warmupUniquePlayed += 1;
  });
  warmupPositions.forEach(position => {
    if (state.adultVisitedPositionIds.has(position.id)) warmupUniquePlayed += 1;
  });

  return {
    warmupTotal: warmupActionIds.size + warmupPositions.length,
    warmupUniquePlayed
  };
}

function unlockedAdultPositions(scene = state.adultScene) {
  const flow = currentAdultFlow();
  const positions = scene?.positions || [];
  const { warmupTotal, warmupUniquePlayed } = adultWarmupStats(scene);
  const corePositions = positions.filter(position => !isWarmupPosition(position) && !isBonusPosition(position));
  const coreVisitedCount = corePositions.filter(position => state.adultVisitedPositionIds.has(position.id)).length;
  const coreAllowed = canUnlockCorePositions({
    flow,
    warmupTotal,
    warmupUniquePlayed
  });
  const bonusAllowed = canUnlockBonusPositions({
    flow,
    coreVisitedCount,
    corePositionCount: corePositions.length,
    bootstrap: warmupTotal === 0 && corePositions.length === 0
  });

  return positions.filter(position => {
    if (flow + 0.001 < Number(position.unlockProgress || 0)) return false;
    if (isWarmupPosition(position)) return true;
    if (isBonusPosition(position)) return coreAllowed && bonusAllowed;
    return coreAllowed;
  });
}

function unlockedAdultOutcomes''',
    'gate core and bonus positions by discovery coverage',
    flags=re.S
)

app = replace_once(
    app,
    "  const choices = [...warmupActions, ...warmupPositions]\n    .sort((a, b) => a.playCount - b.playCount || a.startTime - b.startTime)\n    .slice(0, 4);",
    "  const choices = [...warmupActions, ...warmupPositions]\n    .sort((a, b) => a.playCount - b.playCount || a.startTime - b.startTime)\n    .slice(0, 3);",
    'reduce visible warm-up choices'
)

app = replace_once(
    app,
    "  const phase = adultDiscoveryPhase({\n    flow,\n    hasCoreUnlocked: unlockedCore.some(position => !isBonusPosition(position)),\n    hasBonusUnlocked: unlockedBonus.length > 0,\n    hasOutcomeUnlocked: outcomes.length > 0\n  });",
    "  const proposedPhase = adultDiscoveryPhase({\n    flow,\n    hasCoreUnlocked: unlockedCore.some(position => !isBonusPosition(position)),\n    hasBonusUnlocked: unlockedBonus.length > 0,\n    hasOutcomeUnlocked: outcomes.length > 0\n  });\n  const phase = monotonicAdultPhase(proposedPhase, state.adultLastUiPhase);",
    'make discovery phase monotonic'
)

app = replace_once(
    app,
    "  const next = nextAdultDiscovery(scene);\n  if (els.discoveryGate) {\n    const hideGate = phase === 'final' || !next;\n    els.discoveryGate.classList.toggle('hidden', hideGate);\n    if (!hideGate) {\n      if (els.discoveryGateText) {\n        els.discoveryGateText.textContent = next.type === 'outcome'\n          ? 'Sahnenin son aşaması hâlâ gizli'\n          : 'Yeni bir seçenek yaklaşıyor';\n      }\n      if (els.discoveryGateMeta) {\n        const remaining = Math.max(0, Math.ceil(next.progress - flow));\n        els.discoveryGateMeta.textContent =\n          `%${Math.round(next.progress)} Lust seviyesinde açılır · ${remaining} puan kaldı`;\n      }\n    }\n  }",
    "  const next = nextAdultDiscovery(scene);\n  const warmupStats = adultWarmupStats(scene);\n  const warmupRequired = requiredWarmupDiscoveries(warmupStats.warmupTotal);\n  const warmupRemaining = Math.max(0, warmupRequired - warmupStats.warmupUniquePlayed);\n  if (els.discoveryGate) {\n    const hideGate = phase === 'final' || (!next && warmupRemaining === 0);\n    els.discoveryGate.classList.toggle('hidden', hideGate);\n    if (!hideGate) {\n      if (els.discoveryGateText) {\n        els.discoveryGateText.textContent = warmupRemaining > 0\n          ? 'Yakınlaşmayı biraz daha keşfet'\n          : next?.type === 'outcome'\n            ? 'Sahnenin son aşaması hâlâ gizli'\n            : 'Yeni bir seçenek yaklaşıyor';\n      }\n      if (els.discoveryGateMeta) {\n        if (warmupRemaining > 0) {\n          els.discoveryGateMeta.textContent = `${warmupRemaining} yeni yakınlaşma seçimi daha keşfet`;\n        } else if (next) {\n          const remaining = Math.max(0, Math.ceil(next.progress - flow));\n          els.discoveryGateMeta.textContent =\n            `%${Math.round(next.progress)} Lust seviyesinde açılır · ${remaining} puan kaldı`;\n        }\n      }\n    }\n  }",
    'show warm-up coverage gate instead of only lust threshold'
)

app_path.write_text(app)


# ---------- server.js ----------
server_path = Path('server.js')
server = server_path.read_text()

anchor = '''- Use canonical positionId values consistently: oral, manual, missionary, cowgirl, spoon, standing-rear, rear, standing, or other-stable-N.\n'''
insert = anchor + '''- positionId, positionLabel and the visible body configuration described by label must agree. If they conflict, omit the position instead of guessing.\n- Use missionary only when the receiving partner is visibly below/on their back and MAIN_MALE is visibly above/front-facing in that configuration.\n- Use cowgirl only when the partner is visibly on top/straddling MAIN_MALE. Never reuse missionary for a cowgirl segment or cowgirl for a missionary segment.\n- When the visible body configuration changes from one canonical position to another, end the previous occurrence before the change and start a new occurrence at the first clearly verified frame of the new position.\n'''
server = replace_once(server, anchor, insert, 'strengthen canonical position consistency prompt')

scene_anchor = '''- Set one stable adultSceneId for every action belonging to the same adult scene.\n'''
scene_insert = scene_anchor + '''- Treat one continuous consensual intimate encounter as one adultScene across foreplay, oral/manual activity, position changes, climax and aftermath. Do not create a new adultSceneId merely because the interaction changes from touching/undressing to a sexual position or from one position to another.\n- Start a new adultSceneId only after a clear narrative, location, participant or substantial time break.\n'''
server = replace_once(server, scene_anchor, scene_insert, 'strengthen adult encounter continuity prompt')

server_path.write_text(server)

print('Applied progressive sequence, position consistency, scene continuity, and dub seek fixes.')
