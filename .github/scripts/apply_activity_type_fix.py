from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected 1 match, got {count}")
    return text.replace(old, new, 1)

engine_path = Path('public/engine-hardening.js')
engine = engine_path.read_text()
engine = replace_once(
    engine,
    "export const SECOND_PASS_POSITION_CONFIDENCE = 0.84;\n",
    "export const SECOND_PASS_POSITION_CONFIDENCE = 0.84;\nexport const SECOND_PASS_ACTIVITY_CONFIDENCE = 0.90;\n",
    'activity confidence constant'
)
engine = replace_once(
    engine,
    "function isCorePositionCritical(action = {}) {\n  const hasPosition = Boolean(action.positionId || action.positionLabel || String(action.actionType || '').toLowerCase() === 'position');\n  if (!hasPosition) return false;\n  const family = semanticPositionFamily(action);\n  return Boolean(family && !['oral', 'manual'].includes(family));\n}\n",
    "function isCorePositionCritical(action = {}) {\n  const hasPosition = Boolean(action.positionId || action.positionLabel || String(action.actionType || '').toLowerCase() === 'position');\n  if (!hasPosition) return false;\n  const family = semanticPositionFamily(action);\n  return Boolean(family && !['oral', 'manual'].includes(family));\n}\n\nfunction normalizedActivityType(action = {}) {\n  const value = String(action.activityType || '').trim().toLowerCase();\n  return ['oral', 'manual', 'vaginal', 'anal', 'other'].includes(value) ? value : 'other';\n}\n\nfunction isPenetrativeActivity(action = {}) {\n  return ['vaginal', 'anal'].includes(normalizedActivityType(action));\n}\n\nfunction activityTypeConfidence(action = {}) {\n  const raw = Number(action.activityTypeConfidence);\n  return Number.isFinite(raw) ? clamp(raw, 0, 1) : 0;\n}\n\nfunction activityTypeEvidence(action = {}) {\n  return String(action.activityEvidence || '').trim();\n}\n",
    'activity helpers'
)
engine = replace_once(
    engine,
    "    if (isCorePositionCritical(action) && actionConfidence(action) < SECOND_PASS_POSITION_CONFIDENCE) {\n      selected.add(action);\n    }\n",
    "    if (isCorePositionCritical(action) && isPenetrativeActivity(action) && (\n      activityTypeConfidence(action) < SECOND_PASS_ACTIVITY_CONFIDENCE ||\n      !activityTypeEvidence(action)\n    )) {\n      selected.add(action);\n      return;\n    }\n    if (isCorePositionCritical(action) && actionConfidence(action) < SECOND_PASS_POSITION_CONFIDENCE) {\n      selected.add(action);\n    }\n",
    'activity review selection'
)
engine = replace_once(
    engine,
    "      const familyA = semanticPositionFamily(a);\n      const familyB = semanticPositionFamily(b);\n      if (!familyA || !familyB || familyA === familyB) continue;\n      if (overlapSeconds(a, b) < 1.5) continue;\n      selected.add(a);\n      selected.add(b);\n",
    "      const familyA = semanticPositionFamily(a);\n      const familyB = semanticPositionFamily(b);\n      if (!familyA || !familyB) continue;\n      const overlap = overlapSeconds(a, b);\n      if (overlap < 1.5) continue;\n      const activityA = normalizedActivityType(a);\n      const activityB = normalizedActivityType(b);\n      const routeConflict = familyA === familyB &&\n        ['vaginal', 'anal'].includes(activityA) &&\n        ['vaginal', 'anal'].includes(activityB) &&\n        activityA !== activityB;\n      if (familyA !== familyB || routeConflict) {\n        selected.add(a);\n        selected.add(b);\n      }\n",
    'activity overlap conflict'
)
engine = replace_once(
    engine,
    "    const { __index, ...clean } = action;\n    accepted.push({ ...clean, confidence });\n",
    "    const { __index, ...clean } = action;\n    const route = normalizedActivityType(clean);\n    if (['vaginal', 'anal'].includes(route) && (\n      activityTypeConfidence(clean) < SECOND_PASS_ACTIVITY_CONFIDENCE ||\n      !activityTypeEvidence(clean)\n    )) {\n      clean.activityType = 'other';\n      clean.activityTypeConfidence = activityTypeConfidence(clean);\n      const explicitRouteLabel = /\\b(vajinal|vaginal|anal)\\b/i.test(String(clean.label || ''));\n      if (explicitRouteLabel) clean.label = String(clean.positionLabel || 'Pozisyon').trim();\n      issues.push({\n        severity: 'repair',\n        code: 'UNVERIFIED_ACTIVITY_TYPE',\n        actionId: id,\n        claimedActivityType: route\n      });\n    }\n    accepted.push({ ...clean, confidence });\n",
    'activity hardening repair'
)
engine_path.write_text(engine)

app_path = Path('public/app.js')
app = app_path.read_text()
app = replace_once(
    app,
    "      activityType: String(a.activityType || \"\"),\n      positionLabel: String(a.positionLabel || \"\"),",
    "      activityType: String(a.activityType || \"\"),\n      activityTypeConfidence: Math.max(0, Math.min(1, Number(a.activityTypeConfidence) || 0)),\n      activityEvidence: String(a.activityEvidence || \"\"),\n      positionLabel: String(a.positionLabel || \"\"),",
    'app activity metadata'
)
app_path.write_text(app)

server_path = Path('server.js')
server = server_path.read_text()
server = replace_once(
    server,
    '      "activityType": "oral|manual|vaginal|anal|other",\n      "positionLabel": "",',
    '      "activityType": "oral|manual|vaginal|anal|other",\n      "activityTypeConfidence": 0.0,\n      "activityEvidence": "brief directly visible evidence or empty string",\n      "positionLabel": "",',
    'server response schema activity metadata'
)
server = replace_once(
    server,
    '- Set activityType to oral, manual, vaginal, anal, or other only from direct visible evidence; never guess when evidence is unclear.\n',
    '- Set activityType to oral, manual, vaginal, anal, or other only from direct visible evidence; never guess when evidence is unclear.\n- CRITICAL: positionId never determines penetration route. Missionary, cowgirl, rear, standing-rear, standing, spoon and any other body position can be vaginal or anal. Never default a penetrative position to vaginal.\n- Classify vaginal only when the source frames directly verify vaginal penetration; classify anal only when the source frames directly verify anal penetration. Body angle, position name, dialogue, prior activity, or statistical likelihood are not sufficient by themselves.\n- For vaginal or anal, require the route to remain visually supported at the action start, midpoint and end. If the exact penetration route is occluded, ambiguous, changes off-camera, or cannot be directly distinguished, set activityType to other rather than guessing.\n- Set activityTypeConfidence from 0.0 to 1.0 for the penetration-route classification specifically, independent of general action confidence. Be conservative. A vaginal/anal claim should reach 0.90 only when direct visual evidence is clear and consistent.\n- Set activityEvidence to a brief description of the directly visible evidence supporting activityType. Leave it empty for other/uncertain route. Never use dialogue alone as activityEvidence.\n- The Turkish label may say \"vajinal\" only when activityType is vaginal with activityTypeConfidence >= 0.90 and direct activityEvidence. It may say \"anal\" only when activityType is anal with the same evidence standard. Otherwise the label must name only the verified position/action without claiming penetration route.\n- If the visible route changes between vaginal and anal while the body position stays the same, end the previous action at the verified transition and create a new action with a new positionOccurrenceId. Never carry the previous activityType across that transition.\n',
    'server activity rules'
)
server = replace_once(
    server,
    "          activityType: ['oral', 'manual', 'vaginal', 'anal'].includes(\n            String(action.activityType || '').toLowerCase()\n          )\n            ? String(action.activityType).toLowerCase()\n            : 'other',\n          positionLabel: String(action.positionLabel || ''),",
    "          activityType: ['oral', 'manual', 'vaginal', 'anal'].includes(\n            String(action.activityType || '').toLowerCase()\n          )\n            ? String(action.activityType).toLowerCase()\n            : 'other',\n          activityTypeConfidence: Math.max(0, Math.min(1, Number(action.activityTypeConfidence) || 0)),\n          activityEvidence: String(action.activityEvidence || '').trim(),\n          positionLabel: String(action.positionLabel || ''),",
    'server activity mapping'
)
server_path.write_text(server)

test_path = Path('test/engine-hardening.test.js')
test = test_path.read_text()
insert_after = "test('overlapping incompatible positions force a second pass even at high confidence', () => {\n  const missionary = {\n    actionId: 'm', startTime: 10, endTime: 25, confidence: 0.95, adultSceneId: 's',\n    actionType: 'position', positionId: 'missionary', positionLabel: 'Misyoner'\n  };\n  const cowgirl = {\n    actionId: 'c', startTime: 12, endTime: 24, confidence: 0.94, adultSceneId: 's',\n    actionType: 'position', positionId: 'cowgirl', positionLabel: 'Kovboy'\n  };\n  assert.deepEqual(secondPassReviewCandidates({ actions: [missionary, cowgirl] }).map(x => x.actionId), ['m', 'c']);\n});\n"
addition = insert_after + "\ntest('penetration route uses its own confidence and evidence gate', () => {\n  const ambiguous = {\n    actionId: 'route-low', startTime: 10, endTime: 25, confidence: 0.98, adultSceneId: 's',\n    actionType: 'position', positionId: 'missionary', positionLabel: 'Misyoner',\n    activityType: 'vaginal', activityTypeConfidence: 0.72, activityEvidence: ''\n  };\n  const clear = { ...ambiguous, actionId: 'route-high', activityTypeConfidence: 0.96, activityEvidence: 'direct visible route evidence' };\n  assert.deepEqual(secondPassReviewCandidates({ actions: [ambiguous] }).map(x => x.actionId), ['route-low']);\n  assert.deepEqual(secondPassReviewCandidates({ actions: [clear] }).map(x => x.actionId), []);\n});\n\ntest('same position with conflicting anal and vaginal claims forces route review', () => {\n  const vaginal = {\n    actionId: 'v', startTime: 10, endTime: 25, confidence: 0.97, adultSceneId: 's',\n    actionType: 'position', positionId: 'missionary', positionLabel: 'Misyoner',\n    activityType: 'vaginal', activityTypeConfidence: 0.97, activityEvidence: 'direct visible route evidence'\n  };\n  const anal = { ...vaginal, actionId: 'a', startTime: 12, endTime: 24, activityType: 'anal' };\n  assert.deepEqual(secondPassReviewCandidates({ actions: [vaginal, anal] }).map(x => x.actionId), ['v', 'a']);\n});\n\ntest('hardening downgrades unsupported penetrative route instead of keeping a false explicit label', () => {\n  const { analysis, integrity } = reviewAndHardenAnalysis({\n    videoDuration: 40,\n    actions: [{\n      actionId: 'route', label: 'Vajinal seks', startTime: 10, endTime: 25, confidence: 0.98,\n      adultScene: true, adultSceneId: 's', actionType: 'position', positionId: 'missionary', positionLabel: 'Misyoner',\n      positionStartTime: 10, positionEndTime: 25, loopStartTime: 10, loopEndTime: 25,\n      activityType: 'vaginal', activityTypeConfidence: 0.55, activityEvidence: ''\n    }]\n  });\n  assert.equal(analysis.actions[0].activityType, 'other');\n  assert.equal(analysis.actions[0].label, 'Misyoner');\n  assert.ok(integrity.issues.some(issue => issue.code === 'UNVERIFIED_ACTIVITY_TYPE'));\n});\n"
test = replace_once(test, insert_after, addition, 'activity type tests')
test_path.write_text(test)
