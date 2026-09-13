from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected 1 match, got {count}")
    return text.replace(old, new, 1)

# ----- engine version -----
engine_path = Path('public/engine-hardening.js')
engine = engine_path.read_text()
engine = replace_once(engine, "export const ANALYSIS_SCHEMA_VERSION = 4;\nexport const ENGINE_VERSION = 'videoquest-hardening-v1';", "export const ANALYSIS_SCHEMA_VERSION = 5;\nexport const ENGINE_VERSION = 'videoquest-story-v1';", 'engine version')
engine_path.write_text(engine)

# ----- server -----
server_path = Path('server.js')
server = server_path.read_text()
server = replace_once(server, "const ANALYSIS_SCHEMA_VERSION = 4;\nconst ANALYSIS_ENGINE_VERSION = 'gemini-storyboard-hardening-v1';", "const ANALYSIS_SCHEMA_VERSION = 5;\nconst ANALYSIS_ENGINE_VERSION = 'gemini-storyboard-story-v1';", 'server version')
server = replace_once(server, "    fields: 14\n", "    fields: 16\n", 'multer field limit')
server = replace_once(server, "  const reviewCandidates = String(req.body?.reviewCandidates || '[]').slice(0, 18000);", "  const reviewCandidates = String(req.body?.reviewCandidates || '[]').slice(0, 18000);\n  const storyContextMemory = String(req.body?.storyContextMemory || '{}').slice(0, 24000);", 'story memory field')
server = replace_once(
    server,
    "- Never default an ambiguous penetrative candidate to vaginal. Correct activityType, activityTypeConfidence, activityEvidence and the Turkish label together so they cannot contradict one another.\n` : '';",
    "- Never default an ambiguous penetrative candidate to vaginal. Correct activityType, activityTypeConfidence, activityEvidence and the Turkish label together so they cannot contradict one another.\n- Re-check narrativeChoiceLabel, sceneTitle, sceneGoal, relationshipContext, storyEvidenceLevel, storyConfidence and storyEvidence for supplied candidates. Preserve them only when the same frames/dialogue still support them; otherwise downgrade to neutral wording.\n` : '';",
    'review story instruction'
)
server = replace_once(
    server,
    "- Connect dialogue choices only to matching visible MAIN_MALE actions.\n\nPROTAGONIST IDENTITY LOCK:",
    "- Connect dialogue choices only to matching visible MAIN_MALE actions.\n\nSTORY ENGINE V1 — EVIDENCE-AWARE NARRATIVE UNDERSTANDING:\nPrior verified story memory from earlier chunks:\n${storyContextMemory}\n\n- Understand the scene as a story, not merely a motion list: identify setting, immediate scene purpose, emotional tone, character roles, relationship clues, goals, conflict/tension and meaningful narrative progression.\n- Build story continuity across chunks, but PRIOR MEMORY NEVER OVERRIDES current source frames or current time-aligned dialogue.\n- Separate knowledge into three levels only: fact, inference, unknown.\n- FACT means directly visible or explicitly stated in time-aligned dialogue. Include a short evidence string and confidence.\n- INFERENCE means strongly suggested but not explicit. It must remain phrased as an inference and include evidence/confidence.\n- UNKNOWN means the source does not establish it. Never silently promote unknown information into a fact.\n- Sensitive relationship/background labels such as ex-partner, spouse, step-parent, parent, sibling, relative, boss, employee, teacher, landlord or neighbor may be FACT only when dialogue explicitly states it or unmistakable source evidence proves it. Mere age difference, familiarity, location, clothing, intimacy or body language is never enough.\n- Example: two familiar people meeting at a house does NOT prove 'ex-girlfriend' or 'stepfather'. If dialogue explicitly says they broke up, 'ex-partner' may be a fact. Otherwise keep the exact relationship unknown or as a cautious inference.\n- Return top-level storyContext with synopsisTr, currentSceneTitle, currentSceneGoal, setting, emotionalTone, characters[], relationships[], facts[], inferences[], unknowns[].\n- Every relationship entry must contain from, to, relation, evidenceLevel, confidence and evidence.\n- Every returned action must additionally contain narrativeChoiceLabel, narrativeReason, sceneTitle, sceneGoal, relationshipContext, storyEvidenceLevel, storyConfidence and storyEvidence.\n- narrativeChoiceLabel is the player-facing Turkish story choice. It must describe the meaning of the REAL playable action in context, not invent a branch.\n- narrativeChoiceLabel must still map to that action's exact startTime/endTime. Never write a choice whose promised consequence is absent from that exact source segment.\n- If relationship/background context is uncertain, use neutral story wording such as 'Onunla konuşmaya devam et', 'Neden geldiğini sor' or another source-grounded action instead of asserting an unsupported relationship.\n- Prefer story-aware wording over mechanical wording when evidence supports it: scene intention + interaction + verified action. Do not replace precise sexual-position controls with fictional dialogue or outcomes.\n\nPROTAGONIST IDENTITY LOCK:",
    'story prompt block'
)
server = replace_once(
    server,
    "        label: String(action.label || '').trim(),\n        startTime: Number(action.startTime),",
    "        label: String(action.label || '').trim(),\n        narrativeChoiceLabel: String(action.narrativeChoiceLabel || '').trim(),\n        narrativeReason: String(action.narrativeReason || '').trim(),\n        sceneTitle: String(action.sceneTitle || '').trim(),\n        sceneGoal: String(action.sceneGoal || '').trim(),\n        relationshipContext: String(action.relationshipContext || '').trim(),\n        storyEvidenceLevel: ['fact', 'inference', 'unknown'].includes(String(action.storyEvidenceLevel || '').toLowerCase())\n          ? String(action.storyEvidenceLevel).toLowerCase()\n          : 'unknown',\n        storyConfidence: Math.max(0, Math.min(1, Number(action.storyConfidence) || 0)),\n        storyEvidence: String(action.storyEvidence || '').trim(),\n        startTime: Number(action.startTime),",
    'server action story fields'
)
server = replace_once(
    server,
    "      protagonistProfile: String(parsed.protagonistProfile || protagonistProfile || ''),\n      videoPrompt: String(parsed.videoPrompt || ''),\n      actions,",
    "      protagonistProfile: String(parsed.protagonistProfile || protagonistProfile || ''),\n      videoPrompt: String(parsed.videoPrompt || ''),\n      storyContext: parsed.storyContext && typeof parsed.storyContext === 'object' ? parsed.storyContext : {},\n      actions,",
    'server story context response'
)
server_path.write_text(server)

# ----- app -----
app_path = Path('public/app.js')
app = app_path.read_text()
app = replace_once(
    app,
    "} from './engine-hardening.js';\n\nconst $ = (id) => document.getElementById(id);",
    "} from './engine-hardening.js';\nimport {\n  mergeStoryContexts,\n  normalizeStoryContext,\n  storyActionMeta,\n  storyChoiceLabelForAction\n} from './story-engine.js';\n\nconst $ = (id) => document.getElementById(id);",
    'story imports'
)
app = replace_once(
    app,
    "      label: String(a.label ?? a.action ?? 'Unnamed action'),\n      choiceKey:",
    "      label: String(a.label ?? a.action ?? 'Unnamed action'),\n      narrativeChoiceLabel: String(a.narrativeChoiceLabel || ''),\n      narrativeReason: String(a.narrativeReason || ''),\n      sceneTitle: String(a.sceneTitle || ''),\n      sceneGoal: String(a.sceneGoal || ''),\n      relationshipContext: String(a.relationshipContext || ''),\n      storyEvidenceLevel: String(a.storyEvidenceLevel || 'unknown'),\n      storyConfidence: Math.max(0, Math.min(1, Number(a.storyConfidence) || 0)),\n      storyEvidence: String(a.storyEvidence || ''),\n      choiceKey:",
    'normalize action story fields'
)
app = replace_once(
    app,
    "    videoPrompt: body?.videoPrompt ?? body?.description ?? '',\n    actions: cleaned,",
    "    videoPrompt: body?.videoPrompt ?? body?.description ?? '',\n    storyContext: normalizeStoryContext(body?.storyContext || {}),\n    actions: cleaned,",
    'normalize story context'
)
app = replace_once(
    app,
    "    let protagonistProfile =\n    String(els.protagonistInput?.value || '').trim();",
    "    let protagonistProfile =\n    String(els.protagonistInput?.value || '').trim();\n    let storyContextMemory = normalizeStoryContext({});",
    'story memory variable'
)
app = replace_once(
    app,
    "    form.append('qualityMode', modes.quality);\n    form.append('protagonistProfile', protagonistProfile);",
    "    form.append('qualityMode', modes.quality);\n    form.append('protagonistProfile', protagonistProfile);\n    form.append('storyContextMemory', JSON.stringify(storyContextMemory));",
    'append story memory'
)
app = replace_once(
    app,
    "            chunkResults.push(body);\n            if (body.protagonistProfile) {",
    "            chunkResults.push(body);\n            storyContextMemory = mergeStoryContexts(chunkResults);\n            if (body.protagonistProfile) {",
    'update story memory'
)
app = replace_once(
    app,
    "      const prompts = chunkResults\n        .map(result => String(result.videoPrompt || '').trim())\n        .filter(Boolean);\n\n      const firstResult = chunkResults[0] || {};",
    "      const prompts = chunkResults\n        .map(result => String(result.videoPrompt || '').trim())\n        .filter(Boolean);\n      const mergedStoryContext = mergeStoryContexts(chunkResults);\n\n      const firstResult = chunkResults[0] || {};",
    'merge story context'
)
app = replace_once(
    app,
    "        videoPrompt: prompts.join('\\n\\n'),\n        actions: mergedActions,",
    "        videoPrompt: [\n          mergedStoryContext.synopsisTr ? `HİKÂYE ÖZETİ: ${mergedStoryContext.synopsisTr}` : '',\n          prompts.join('\\n\\n')\n        ].filter(Boolean).join('\\n\\n'),\n        storyContext: mergedStoryContext,\n        actions: mergedActions,",
    'merged result story context'
)
app = replace_once(
    app,
    "    videoPrompt: state.analysis?.videoPrompt ?? null,\n    ...extra,",
    "    videoPrompt: state.analysis?.videoPrompt ?? null,\n    storyContext: state.analysis?.storyContext ?? null,\n    ...extra,",
    'debug story context'
) if "    videoPrompt: state.analysis?.videoPrompt ?? null,\n    ...extra," in app else app
# renderDebug currently has no videoPrompt field; insert after integrityReport instead.
if "storyContext: state.analysis?.storyContext ?? null" not in app:
    app = replace_once(
        app,
        "    integrityReport: state.integrityReport,\n    adultPhaseMachine:",
        "    integrityReport: state.integrityReport,\n    storyContext: state.analysis?.storyContext ?? null,\n    adultPhaseMachine:",
        'debug story context fallback'
    )
app = replace_once(
    app,
    "    button.className = 'choice';\n    button.innerHTML = `\n      <div class=\"choice-title\">${escapeHtml(action.label)}</div>\n      <div class=\"choice-meta\">${action.startTime.toFixed(2)} → ${action.endTime.toFixed(2)} sn • ${(action.confidence * 100).toFixed(0)}%</div>\n    `;",
    "    button.className = 'choice';\n    const storyLabel = storyChoiceLabelForAction(action);\n    const storyMeta = storyActionMeta(action);\n    const scenePrefix = storyMeta.sceneTitle ? `${escapeHtml(storyMeta.sceneTitle)} · ` : '';\n    button.innerHTML = `\n      <div class=\"choice-title\">${escapeHtml(storyLabel)}</div>\n      <div class=\"choice-meta\">${scenePrefix}${action.startTime.toFixed(2)} → ${action.endTime.toFixed(2)} sn • ${(action.confidence * 100).toFixed(0)}%</div>\n    `;",
    'story-aware choice rendering'
)
app = replace_once(
    app,
    "    div.innerHTML = `<b>${String(i + 1).padStart(2, '0')} • ${escapeHtml(a.label)}</b><div class=\"meta\">${a.startTime.toFixed(3)} → ${a.endTime.toFixed(3)} • ${escapeHtml(a.actionId)}</div>`;",
    "    div.innerHTML = `<b>${String(i + 1).padStart(2, '0')} • ${escapeHtml(storyChoiceLabelForAction(a))}</b><div class=\"meta\">${a.startTime.toFixed(3)} → ${a.endTime.toFixed(3)} • ${escapeHtml(a.actionId)}</div>`;",
    'timeline story label'
)
app_path.write_text(app)

# ----- package test command -----
package_path = Path('package.json')
package = package_path.read_text()
package = replace_once(
    package,
    "node --check public/engine-hardening.js && node --test test/adult-gameplay.test.js test/playback-logic.test.js test/engine-hardening.test.js",
    "node --check public/engine-hardening.js && node --check public/story-engine.js && node --test test/adult-gameplay.test.js test/playback-logic.test.js test/engine-hardening.test.js test/story-engine.test.js",
    'package story tests'
)
package_path.write_text(package)
