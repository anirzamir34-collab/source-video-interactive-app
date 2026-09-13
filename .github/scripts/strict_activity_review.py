from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected 1 match, got {count}")
    return text.replace(old, new, 1)

engine_path = Path('public/engine-hardening.js')
engine = engine_path.read_text()
old = '''    if (isCorePositionCritical(action) && isPenetrativeActivity(action) && (
      activityTypeConfidence(action) < SECOND_PASS_ACTIVITY_CONFIDENCE ||
      !activityTypeEvidence(action)
    )) {
      selected.add(action);
      return;
    }
'''
new = '''    if (isCorePositionCritical(action) && isPenetrativeActivity(action)) {
      // Route classification is gameplay-critical. Re-check every explicit
      // vaginal/anal claim once, even when first-pass confidence is high.
      // Candidates are batched per storyboard chunk, so this does not double
      // every adult-analysis request.
      selected.add(action);
      return;
    }
'''
engine = replace_once(engine, old, new, 'always review penetrative activity type')
engine_path.write_text(engine)

server_path = Path('server.js')
server = server_path.read_text()
old = '''- If a candidate conflicts with the frames, another position label, scene chronology, or its parent range, OMIT it and add a warning.
- Outcome/final candidates require stronger evidence than ordinary actions.
` : '';
'''
new = '''- If a candidate conflicts with the frames, another position label, scene chronology, or its parent range, OMIT it and add a warning.
- Outcome/final candidates require stronger evidence than ordinary actions.
- For any candidate whose first-pass activityType is vaginal or anal, independently classify the route again from the SAME visible frames. Treat the first-pass route as untrusted; do not preserve it merely for consistency.
- Body position never proves route: missionary, cowgirl, rear, standing-rear, spoon and similar configurations can be vaginal or anal.
- Return vaginal or anal only when the visible contact/penetration location is directly distinguishable and consistent at the candidate start, midpoint and end. Otherwise return activityType other with low activityTypeConfidence, or omit the candidate.
- Never default an ambiguous penetrative candidate to vaginal. Correct activityType, activityTypeConfidence, activityEvidence and the Turkish label together so they cannot contradict one another.
` : '';
'''
server = replace_once(server, old, new, 'strict second-pass route instructions')
server_path.write_text(server)

test_path = Path('test/engine-hardening.test.js')
test = test_path.read_text()
old = '''test('penetration route uses its own confidence and evidence gate', () => {
  const ambiguous = {
    actionId: 'route-low', startTime: 10, endTime: 25, confidence: 0.98, adultSceneId: 's',
    actionType: 'position', positionId: 'missionary', positionLabel: 'Misyoner',
    activityType: 'vaginal', activityTypeConfidence: 0.72, activityEvidence: ''
  };
  const clear = { ...ambiguous, actionId: 'route-high', activityTypeConfidence: 0.96, activityEvidence: 'direct visible route evidence' };
  assert.deepEqual(secondPassReviewCandidates({ actions: [ambiguous] }).map(x => x.actionId), ['route-low']);
  assert.deepEqual(secondPassReviewCandidates({ actions: [clear] }).map(x => x.actionId), []);
});
'''
new = '''test('every explicit vaginal or anal claim receives one visual route recheck', () => {
  const ambiguous = {
    actionId: 'route-low', startTime: 10, endTime: 25, confidence: 0.98, adultSceneId: 's',
    actionType: 'position', positionId: 'missionary', positionLabel: 'Misyoner',
    activityType: 'vaginal', activityTypeConfidence: 0.72, activityEvidence: ''
  };
  const clear = { ...ambiguous, actionId: 'route-high', activityTypeConfidence: 0.96, activityEvidence: 'direct visible route evidence' };
  const anal = { ...clear, actionId: 'route-anal', startTime: 30, endTime: 45, activityType: 'anal' };
  assert.deepEqual(secondPassReviewCandidates({ actions: [ambiguous] }).map(x => x.actionId), ['route-low']);
  assert.deepEqual(secondPassReviewCandidates({ actions: [clear, anal] }).map(x => x.actionId), ['route-high', 'route-anal']);
});
'''
test = replace_once(test, old, new, 'strict route review test')
test_path.write_text(test)
