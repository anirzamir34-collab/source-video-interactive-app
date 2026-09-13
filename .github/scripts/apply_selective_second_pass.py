from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected 1 match, got {count}")
    return text.replace(old, new, 1)

engine_path = Path('public/engine-hardening.js')
engine = engine_path.read_text()
old = '''export function shouldSecondPassReview(result = {}) {
  const actions = Array.isArray(result.actions) ? result.actions : [];
  if (!actions.length) return false;
  if (actions.some(action => action.adultScene)) return true;
  if (actions.some(action => actionConfidence(action) < 0.78)) return true;
  for (let index = 1; index < actions.length; index += 1) {
    if (numberOr(actions[index].startTime) < numberOr(actions[index - 1].endTime) - 0.1) return true;
  }
  return false;
}
'''
new = '''export const SECOND_PASS_POSITION_CONFIDENCE = 0.84;

function isOutcomeCritical(action = {}) {
  const type = String(action.actionType || '').toLowerCase();
  const outcome = String(action.outcomeType || '').toLowerCase();
  return type === 'outcome' || outcome === 'climax';
}

function isCorePositionCritical(action = {}) {
  const hasPosition = Boolean(action.positionId || action.positionLabel || String(action.actionType || '').toLowerCase() === 'position');
  if (!hasPosition) return false;
  const family = semanticPositionFamily(action);
  return Boolean(family && !['oral', 'manual'].includes(family));
}

export function secondPassReviewCandidates(result = {}) {
  const actions = Array.isArray(result.actions) ? result.actions : [];
  if (!actions.length) return [];

  const selected = new Set();

  // Final/outcome mistakes are expensive in gameplay, so they always receive
  // one visual verification pass. Ordinary foreplay and generic actions do not.
  actions.forEach(action => {
    if (isOutcomeCritical(action)) {
      selected.add(action);
      return;
    }
    if (isCorePositionCritical(action) && actionConfidence(action) < SECOND_PASS_POSITION_CONFIDENCE) {
      selected.add(action);
    }
  });

  // Even high-confidence position labels are rechecked when two incompatible
  // canonical positions claim the same source-video interval.
  const positions = actions
    .filter(action => Boolean(action.positionId || action.positionLabel || String(action.actionType || '').toLowerCase() === 'position'))
    .sort((a, b) => numberOr(a.startTime) - numberOr(b.startTime));

  for (let left = 0; left < positions.length; left += 1) {
    const a = positions[left];
    for (let right = left + 1; right < positions.length; right += 1) {
      const b = positions[right];
      if (numberOr(b.startTime) >= numberOr(a.endTime)) break;
      if (String(a.adultSceneId || '') !== String(b.adultSceneId || '')) continue;
      const familyA = semanticPositionFamily(a);
      const familyB = semanticPositionFamily(b);
      if (!familyA || !familyB || familyA === familyB) continue;
      if (overlapSeconds(a, b) < 1.5) continue;
      selected.add(a);
      selected.add(b);
    }
  }

  return actions.filter(action => selected.has(action));
}

export function shouldSecondPassReview(result = {}) {
  return secondPassReviewCandidates(result).length > 0;
}

export function mergeSecondPassReview(firstPass = {}, reviewPass = {}, candidates = []) {
  const firstActions = Array.isArray(firstPass.actions) ? firstPass.actions : [];
  const reviewedActions = Array.isArray(reviewPass.actions) ? reviewPass.actions : [];
  const candidateIds = new Set(
    (Array.isArray(candidates) ? candidates : [])
      .map(action => String(action?.actionId || ''))
      .filter(Boolean)
  );

  const untouched = firstActions.filter(action => !candidateIds.has(String(action?.actionId || '')));
  // A second pass may verify, correct, or omit only the supplied candidates.
  // It is never allowed to invent a brand-new action id.
  const verified = reviewedActions.filter(action => candidateIds.has(String(action?.actionId || '')));
  const actions = [...untouched, ...verified]
    .sort((a, b) => numberOr(a.startTime) - numberOr(b.startTime));
  const warnings = [...new Set([
    ...(Array.isArray(firstPass.warnings) ? firstPass.warnings : []),
    ...(Array.isArray(reviewPass.warnings) ? reviewPass.warnings : [])
  ])];

  return {
    ...firstPass,
    ...reviewPass,
    actions,
    warnings,
    secondPassReviewed: true,
    secondPassCandidateCount: candidateIds.size,
    firstPassActionCount: firstActions.length
  };
}
'''
engine = replace_once(engine, old, new, 'engine second pass selector')
engine_path.write_text(engine)

app_path = Path('public/app.js')
app = app_path.read_text()
app = replace_once(
    app,
    "  isCompatibleRuntimeSnapshot,\n  reviewAndHardenAnalysis,\n  shouldSecondPassReview\n} from './engine-hardening.js';",
    "  isCompatibleRuntimeSnapshot,\n  mergeSecondPassReview,\n  reviewAndHardenAnalysis,\n  secondPassReviewCandidates\n} from './engine-hardening.js';",
    'app hardening imports'
)
old_block = '''            if (shouldSecondPassReview(body)) {
              form.set('reviewMode', '1');
              form.set('reviewCandidates', JSON.stringify(body.actions || []));
              els.analysisOutput.textContent =
                `${chunkStart.toFixed(1)}–${chunkEnd.toFixed(1)} saniye ikinci kez doğrulanıyor...`;
              const reviewResponse = await fetch('/api/gemini-storyboard-analyze', {
                method: 'POST',
                body: form,
                signal: AbortSignal.timeout(240000)
              });
              const reviewBody = await reviewResponse.json();
              if (!reviewResponse.ok || !reviewBody?.available) {
                failureBody = reviewBody || {
                  available: false,
                  reason: 'SECOND_PASS_REVIEW_FAILED',
                  message: `Bölüm ${chunkIndex + 1} ikinci doğrulamadan geçemedi.`
                };
                continue;
              }
              body = {
                ...reviewBody,
                secondPassReviewed: true,
                firstPassActionCount: Array.isArray(body.actions) ? body.actions.length : 0
              };
            }
'''
new_block = '''            const criticalReviewCandidates = secondPassReviewCandidates(body);
            if (criticalReviewCandidates.length) {
              form.set('reviewMode', '1');
              form.set('reviewCandidates', JSON.stringify(criticalReviewCandidates));
              els.analysisOutput.textContent =
                `${chunkStart.toFixed(1)}–${chunkEnd.toFixed(1)} saniye · ${criticalReviewCandidates.length} kritik aday ikinci kez doğrulanıyor...`;
              const reviewResponse = await fetch('/api/gemini-storyboard-analyze', {
                method: 'POST',
                body: form,
                signal: AbortSignal.timeout(240000)
              });
              const reviewBody = await reviewResponse.json();
              if (!reviewResponse.ok || !reviewBody?.available) {
                failureBody = reviewBody || {
                  available: false,
                  reason: 'SECOND_PASS_REVIEW_FAILED',
                  message: `Bölüm ${chunkIndex + 1} ikinci doğrulamadan geçemedi.`
                };
                continue;
              }
              body = mergeSecondPassReview(body, reviewBody, criticalReviewCandidates);
            }
'''
app = replace_once(app, old_block, new_block, 'app selective review block')
app_path.write_text(app)

test_path = Path('test/engine-hardening.test.js')
test = test_path.read_text()
test = replace_once(
    test,
    "  isCompatibleRuntimeSnapshot,\n  reviewAndHardenAnalysis,\n  shouldSecondPassReview,\n  validateActionInterval",
    "  isCompatibleRuntimeSnapshot,\n  mergeSecondPassReview,\n  reviewAndHardenAnalysis,\n  secondPassReviewCandidates,\n  shouldSecondPassReview,\n  validateActionInterval",
    'test imports'
)
old_test = '''test('adult or low-confidence chunks request a visual second review pass', () => {
  assert.equal(shouldSecondPassReview({ actions: [{ startTime: 0, endTime: 1, confidence: 0.9 }] }), false);
  assert.equal(shouldSecondPassReview({ actions: [{ startTime: 0, endTime: 1, confidence: 0.7 }] }), true);
  assert.equal(shouldSecondPassReview({ actions: [{ startTime: 0, endTime: 1, confidence: 0.95, adultScene: true }] }), true);
});
'''
new_test = '''test('second visual pass is selective: only critical positions, conflicts and finals', () => {
  const genericLow = { actionId: 'g', startTime: 0, endTime: 2, confidence: 0.6 };
  const foreplayHigh = { actionId: 'f', startTime: 2, endTime: 5, confidence: 0.95, adultScene: true, actionType: 'touch' };
  const coreHigh = {
    actionId: 'p-high', startTime: 10, endTime: 25, confidence: 0.95, adultScene: true,
    adultSceneId: 's', actionType: 'position', positionId: 'missionary', positionLabel: 'Misyoner'
  };
  const coreLow = { ...coreHigh, actionId: 'p-low', startTime: 30, endTime: 45, confidence: 0.78 };
  const oralLow = {
    actionId: 'oral', startTime: 46, endTime: 58, confidence: 0.76, adultScene: true,
    adultSceneId: 's', actionType: 'position', positionId: 'oral', positionLabel: 'Oral'
  };
  const final = {
    actionId: 'final', startTime: 60, endTime: 65, confidence: 0.96, adultScene: true,
    adultSceneId: 's', actionType: 'outcome', outcomeType: 'climax'
  };

  assert.equal(shouldSecondPassReview({ actions: [genericLow, foreplayHigh, coreHigh, oralLow] }), false);
  assert.deepEqual(secondPassReviewCandidates({ actions: [genericLow, coreLow, final] }).map(x => x.actionId), ['p-low', 'final']);
  assert.equal(shouldSecondPassReview({ actions: [final] }), true);
});

test('overlapping incompatible positions force a second pass even at high confidence', () => {
  const missionary = {
    actionId: 'm', startTime: 10, endTime: 25, confidence: 0.95, adultSceneId: 's',
    actionType: 'position', positionId: 'missionary', positionLabel: 'Misyoner'
  };
  const cowgirl = {
    actionId: 'c', startTime: 12, endTime: 24, confidence: 0.94, adultSceneId: 's',
    actionType: 'position', positionId: 'cowgirl', positionLabel: 'Kovboy'
  };
  assert.deepEqual(secondPassReviewCandidates({ actions: [missionary, cowgirl] }).map(x => x.actionId), ['m', 'c']);
});

test('selective review preserves safe first-pass actions and rejects invented review ids', () => {
  const safe = { actionId: 'safe', label: 'Dokun', startTime: 1, endTime: 3, confidence: 0.95 };
  const risky = { actionId: 'risky', label: 'Misyoner', startTime: 10, endTime: 20, confidence: 0.78 };
  const reviewedRisky = { ...risky, confidence: 0.93, positionId: 'missionary' };
  const invented = { actionId: 'invented', label: 'Uydurma', startTime: 30, endTime: 40, confidence: 1 };
  const merged = mergeSecondPassReview(
    { actions: [safe, risky], warnings: ['first'] },
    { actions: [reviewedRisky, invented], warnings: ['review'] },
    [risky]
  );
  assert.deepEqual(merged.actions.map(x => x.actionId), ['safe', 'risky']);
  assert.equal(merged.actions.find(x => x.actionId === 'risky').confidence, 0.93);
  assert.deepEqual(merged.warnings, ['first', 'review']);
});
'''
test = replace_once(test, old_test, new_test, 'selective second-pass tests')
test_path.write_text(test)
