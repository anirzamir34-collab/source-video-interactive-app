from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected 1 match, got {count}")
    return text.replace(old, new, 1)

# --- engine hardening ---
engine_path = Path('public/engine-hardening.js')
engine = engine_path.read_text()

old = """export const SECOND_PASS_POSITION_CONFIDENCE = 0.84;\n\nfunction isOutcomeCritical(action = {}) {\n"""
new = """export const SECOND_PASS_POSITION_CONFIDENCE = 0.84;\nexport const ACTIVITY_TYPE_REVIEW_CONFIDENCE = 0.86;\n\nexport function activityTypeConfidence(action = {}) {\n  const raw = Number(action.activityTypeConfidence);\n  if (Number.isFinite(raw)) return clamp(raw, 0, 1);\n  return 0;\n}\n\nfunction isPenetrativeActivity(action = {}) {\n  return ['vaginal', 'anal'].includes(String(action.activityType || '').toLowerCase());\n}\n\nfunction isOutcomeCritical(action = {}) {\n"""
engine = replace_once(engine, old, new, 'activity confidence helpers')

old = """  actions.forEach(action => {\n    if (isOutcomeCritical(action)) {\n      selected.add(action);\n      return;\n    }\n    if (isCorePositionCritical(action) && actionConfidence(action) < SECOND_PASS_POSITION_CONFIDENCE) {\n      selected.add(action);\n    }\n  });\n"""
new = """  actions.forEach(action => {\n    if (isOutcomeCritical(action)) {\n      selected.add(action);\n      return;\n    }\n\n    // Vaginal vs anal is independent from body position. Every explicit\n    // penetrative classification gets one visual re-check before gameplay,\n    // even when the general action confidence is high. Candidates are batched\n    // per chunk, so this remains much cheaper than reviewing every adult action.\n    if (isCorePositionCritical(action) && isPenetrativeActivity(action)) {\n      selected.add(action);\n      return;\n    }\n\n    if (isCorePositionCritical(action) && actionConfidence(action) < SECOND_PASS_POSITION_CONFIDENCE) {\n      selected.add(action);\n    }\n  });\n"""
engine = replace_once(engine, old, new, 'penetrative second-pass selection')
engine_path.write_text(engine)

# --- client normalization ---
app_path = Path('public/app.js')
app = app_path.read_text()
old = """      positionOccurrenceId: String(a.positionOccurrenceId || \"\"),\n      activityType: String(a.activityType || \"\"),\n      positionLabel: String(a.positionLabel || \"\"),\n"""
new = """      positionOccurrenceId: String(a.positionOccurrenceId || \"\"),\n      activityType: ['oral', 'manual', 'vaginal', 'anal'].includes(String(a.activityType || '').toLowerCase())\n        ? String(a.activityType).toLowerCase()\n        : 'other',\n      activityTypeConfidence: Math.max(0, Math.min(1, Number(a.activityTypeConfidence) || 0)),\n      positionLabel: String(a.positionLabel || \"\"),\n"""
app = replace_once(app, old, new, 'client activity normalization')
app_path.write_text(app)

# --- Gemini prompt and response normalization ---
server_path = Path('server.js')
server = server_path.read_text()

old = """- Outcome/final candidates require stronger evidence than ordinary actions.\n` : '';\n"""
new = """- Outcome/final candidates require stronger evidence than ordinary actions.\n- For vaginal/anal candidates, independently re-determine activityType from the visible penetration/contact location. Ignore the first-pass activityType as a prior.\n- A rear-facing, missionary, cowgirl, spoon or standing body position NEVER proves vaginal vs anal by itself.\n- If the exact penetration/contact location is not directly distinguishable, set activityType to other and activityTypeConfidence below 0.5, or omit the candidate. Never default to vaginal.\n- If the visible activity changes between vaginal and anal, do not carry the old type forward; the first-pass candidate must be rejected unless its exact interval is internally consistent.\n` : '';\n"""
server = replace_once(server, old, new, 'review instructions')

old = """      \"activityType\": \"oral|manual|vaginal|anal|other\",\n      \"positionLabel\": \"\",\n"""
new = """      \"activityType\": \"oral|manual|vaginal|anal|other\",\n      \"activityTypeConfidence\": 0.0,\n      \"positionLabel\": \"\",\n"""
server = replace_once(server, old, new, 'response shape activity confidence')

old = """- Set activityType to oral, manual, vaginal, anal, or other only from direct visible evidence; never guess when evidence is unclear.\n- Verify every position and internal movement against its exact start frame, midpoint frame and end frame from the source video.\n"""
new = """- POSITION AND ACTIVITY TYPE ARE INDEPENDENT. positionId describes body arrangement only; it must never determine activityType. A rear-facing, missionary, cowgirl, spoon, standing or any other body arrangement can never by itself prove vaginal or anal activity.\n- Determine activityType independently for EACH action from direct visible evidence at that exact interval. Never inherit activityType from the previous action, the same position family, dialogue, scene context, or a neighboring timestamp.\n- Use activityType \"vaginal\" only when the visible penetration/contact location clearly supports vaginal activity. Use \"anal\" only when the visible penetration/contact location clearly supports anal activity.\n- If vaginal versus anal cannot be directly distinguished from the sampled source frames, use activityType \"other\" and activityTypeConfidence below 0.5. NEVER default an uncertain penetrative action to vaginal.\n- activityTypeConfidence is confidence in the activity-type classification specifically, independent of the general action confidence.\n- If activityType changes vaginal → anal or anal → vaginal while the body position otherwise stays the same, END the previous action at the visible transition and START a separate action with a new positionOccurrenceId. Do not merge across that transition.\n- A single action interval may not contain both vaginal and anal activity. Its start, midpoint and end frames must all support the same activityType; otherwise split it or omit it.\n- Turkish label text must agree with the verified activityType. Never write \"vajinal\" for activityType anal, never write \"anal\" for activityType vaginal, and when activityType is other do not name either one in the label.\n- Set activityType to oral, manual, vaginal, anal, or other only from direct visible evidence; never guess when evidence is unclear.\n- Verify every position, activityType, and internal movement against its exact start frame, midpoint frame and end frame from the source video.\n"""
server = replace_once(server, old, new, 'strict activity type rules')

old = """          activityType: ['oral', 'manual', 'vaginal', 'anal'].includes(\n            String(action.activityType || '').toLowerCase()\n          )\n            ? String(action.activityType).toLowerCase()\n            : 'other',\n          positionLabel: String(action.positionLabel || ''),\n"""
new = """          activityType: ['oral', 'manual', 'vaginal', 'anal'].includes(\n            String(action.activityType || '').toLowerCase()\n          )\n            ? String(action.activityType).toLowerCase()\n            : 'other',\n          activityTypeConfidence: Math.max(0, Math.min(1, Number(action.activityTypeConfidence) || 0)),\n          positionLabel: String(action.positionLabel || ''),\n"""
server = replace_once(server, old, new, 'server activity confidence normalization')
server_path.write_text(server)

# --- tests ---
test_path = Path('test/engine-hardening.test.js')
test = test_path.read_text()
old = """  ANALYSIS_SCHEMA_VERSION,\n  ENGINE_VERSION,\n  actionConfidence,\n"""
new = """  ANALYSIS_SCHEMA_VERSION,\n  ENGINE_VERSION,\n  actionConfidence,\n  activityTypeConfidence,\n"""
test = replace_once(test, old, new, 'test activity confidence import')

anchor = """test('overlapping incompatible positions force a second pass even at high confidence', () => {\n"""
insert = """test('every explicit vaginal or anal core position receives a visual activity-type recheck', () => {\n  const vaginal = {\n    actionId: 'v', startTime: 10, endTime: 24, confidence: 0.97, activityTypeConfidence: 0.96,\n    adultScene: true, adultSceneId: 's', actionType: 'position', positionId: 'rear', positionLabel: 'Arkadan',\n    activityType: 'vaginal'\n  };\n  const anal = { ...vaginal, actionId: 'a', startTime: 30, endTime: 45, activityType: 'anal' };\n  const neutral = { ...vaginal, actionId: 'o', startTime: 50, endTime: 65, activityType: 'other' };\n\n  assert.deepEqual(secondPassReviewCandidates({ actions: [vaginal, anal, neutral] }).map(x => x.actionId), ['v', 'a']);\n  assert.equal(activityTypeConfidence(vaginal), 0.96);\n  assert.equal(activityTypeConfidence({ activityTypeConfidence: 3 }), 1);\n});\n\n"""
if anchor not in test:
    raise RuntimeError('test insertion anchor missing')
test = test.replace(anchor, insert + anchor, 1)
test_path.write_text(test)
