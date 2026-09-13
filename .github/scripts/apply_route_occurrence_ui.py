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
    "function normalizedActivityType(action = {}) {\n  const value = String(action.activityType || '').trim().toLowerCase();\n  return ['oral', 'manual', 'vaginal', 'anal', 'other'].includes(value) ? value : 'other';\n}\n",
    "export function normalizedActivityType(action = {}) {\n  const value = String(action.activityType || '').trim().toLowerCase();\n  return ['oral', 'manual', 'vaginal', 'anal', 'other'].includes(value) ? value : 'other';\n}\n\nexport function verifiedActivityRoute(action = {}) {\n  const route = normalizedActivityType(action);\n  if (['oral', 'manual'].includes(route)) return route;\n  if (!['vaginal', 'anal'].includes(route)) return 'other';\n  const confidence = Number(action.activityTypeConfidence);\n  const evidence = String(action.activityEvidence || '').trim();\n  return Number.isFinite(confidence) && confidence >= SECOND_PASS_ACTIVITY_CONFIDENCE && evidence\n    ? route\n    : 'other';\n}\n\nexport function activityOccurrenceNamespace(action = {}) {\n  return verifiedActivityRoute(action);\n}\n\nexport function activityDisplayLabel(baseLabel, action = {}) {\n  const base = String(baseLabel || 'Pozisyon').trim() || 'Pozisyon';\n  const route = verifiedActivityRoute(action);\n  if (route === 'vaginal') return `${base} · Vajinal`;\n  if (route === 'anal') return `${base} · Anal`;\n  return base;\n}\n",
    'export route helpers'
)
engine_path.write_text(engine)

app_path = Path('public/app.js')
app = app_path.read_text()
app = replace_once(
    app,
    "  ANALYSIS_SCHEMA_VERSION,\n  ENGINE_VERSION,\n  advanceAdultPhase,",
    "  ANALYSIS_SCHEMA_VERSION,\n  ENGINE_VERSION,\n  activityDisplayLabel,\n  activityOccurrenceNamespace,\n  advanceAdultPhase,",
    'app route helper imports'
)
app = replace_once(
    app,
    "    const endTime = Math.max(startTime, endCandidate);\n    const key = `${sceneId}::${familyId}`;\n\n    if (!groups.has(key)) {\n      groups.set(key, { sceneId, familyId, entries: [] });\n    }",
    "    const endTime = Math.max(startTime, endCandidate);\n    const routeNamespace = activityOccurrenceNamespace(action);\n    const key = `${sceneId}::${familyId}::${routeNamespace}`;\n\n    if (!groups.has(key)) {\n      groups.set(key, { sceneId, familyId, routeNamespace, entries: [] });\n    }",
    'occurrence group route namespace'
)
app = replace_once(
    app,
    '''        const familySlug = normalizeAdultLabel(group.familyId)
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '') || 'position';
        occurrence = {
          id: `${sceneSlug}:${familySlug}:occ-${String(generatedCount).padStart(2, '0')}-${Math.round(entry.startTime * 1000)}`,
''',
    '''        const familySlug = normalizeAdultLabel(group.familyId)
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '') || 'position';
        const routeSlug = normalizeAdultLabel(group.routeNamespace || 'other')
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '') || 'other';
        occurrence = {
          id: `${sceneSlug}:${familySlug}:${routeSlug}:occ-${String(generatedCount).padStart(2, '0')}-${Math.round(entry.startTime * 1000)}`,
''',
    'generated occurrence route slug'
)
app = replace_once(
    app,
    "    const positionKey = `${category.id}:${canonical.id}:${occurrenceId}`;\n\n    if (!scene.positions.has(positionKey)) {\n      scene.positions.set(positionKey, {\n        id: positionKey,\n        familyId: canonical.id,\n        occurrenceId,\n        label: canonical.label,",
    "    const routeNamespace = activityOccurrenceNamespace(action);\n    const positionKey = `${category.id}:${canonical.id}:${routeNamespace}:${occurrenceId}`;\n\n    if (!scene.positions.has(positionKey)) {\n      scene.positions.set(positionKey, {\n        id: positionKey,\n        familyId: canonical.id,\n        occurrenceId,\n        activityType: routeNamespace,\n        activityTypeConfidence: Number(action.activityTypeConfidence || 0),\n        label: activityDisplayLabel(canonical.label, action),",
    'position key and label route'
)
app = replace_once(
    app,
    "      const key = `${position.categoryId}:${position.familyId}`;\n      totals.set(key, (totals.get(key) || 0) + 1);",
    "      const key = `${position.categoryId}:${position.familyId}:${position.activityType || 'other'}`;\n      totals.set(key, (totals.get(key) || 0) + 1);",
    'position numbering totals route'
)
app = replace_once(
    app,
    "      const key = `${position.categoryId}:${position.familyId}`;\n      if ((totals.get(key) || 0) > 1) {",
    "      const key = `${position.categoryId}:${position.familyId}:${position.activityType || 'other'}`;\n      if ((totals.get(key) || 0) > 1) {",
    'position numbering indexes route'
)
app_path.write_text(app)

test_path = Path('test/engine-hardening.test.js')
test = test_path.read_text()
test = replace_once(
    test,
    "  ANALYSIS_SCHEMA_VERSION,\n  ENGINE_VERSION,\n  actionConfidence,",
    "  ANALYSIS_SCHEMA_VERSION,\n  ENGINE_VERSION,\n  activityDisplayLabel,\n  activityOccurrenceNamespace,\n  actionConfidence,",
    'test route helper imports'
)
marker = "test('same position with conflicting anal and vaginal claims forces route review', () => {\n"
idx = test.index(marker)
new_tests = """test('verified activity route gets its own occurrence namespace and display label', () => {\n  const vaginal = {\n    activityType: 'vaginal', activityTypeConfidence: 0.96, activityEvidence: 'direct visible evidence'\n  };\n  const anal = {\n    activityType: 'anal', activityTypeConfidence: 0.97, activityEvidence: 'direct visible evidence'\n  };\n  assert.equal(activityOccurrenceNamespace(vaginal), 'vaginal');\n  assert.equal(activityOccurrenceNamespace(anal), 'anal');\n  assert.equal(activityDisplayLabel('Misyoner', vaginal), 'Misyoner · Vajinal');\n  assert.equal(activityDisplayLabel('Misyoner', anal), 'Misyoner · Anal');\n});\n\ntest('uncertain penetrative route never creates an explicit UI route label', () => {\n  const uncertain = {\n    activityType: 'vaginal', activityTypeConfidence: 0.72, activityEvidence: ''\n  };\n  assert.equal(activityOccurrenceNamespace(uncertain), 'other');\n  assert.equal(activityDisplayLabel('Misyoner', uncertain), 'Misyoner');\n});\n\n"""
test = test[:idx] + new_tests + test[idx:]
test_path.write_text(test)
