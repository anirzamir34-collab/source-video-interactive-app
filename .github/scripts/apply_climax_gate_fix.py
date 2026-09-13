from pathlib import Path
import re

path = Path('public/app.js')
text = path.read_text()


def replace_once(old, new, label):
    global text
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: expected 1 match, got {count}')
    text = text.replace(old, new, 1)


replace_once(
    "  canUnlockBonusPositions,\n  canUnlockCorePositions,\n  computeAdultSelectionDelta,",
    "  canUnlockBonusPositions,\n  canUnlockCorePositions,\n  canUnlockOutcome,\n  computeAdultSelectionDelta,",
    'import canUnlockOutcome'
)

replace_once(
    "  adultComboCount: 0,\n  adultOutcomePhase: 'idle',",
    "  adultComboCount: 0,\n  adultClimaxProgress: 0,\n  adultCorePlaySeconds: 0,\n  adultOutcomePhase: 'idle',",
    'state climax fields'
)

reset_marker = "  state.adultComboCount = 0;\n  state.adultOutcomePhase = 'idle';"
count = text.count(reset_marker)
if count != 2:
    raise RuntimeError(f'reset climax fields: expected 2 matches, got {count}')
text = text.replace(
    reset_marker,
    "  state.adultComboCount = 0;\n  state.adultClimaxProgress = 0;\n  state.adultCorePlaySeconds = 0;\n  state.adultOutcomePhase = 'idle';"
)

replace_once(
    "function unlockedAdultOutcomes(scene = state.adultScene) {\n  return (scene?.outcomes || []).filter(outcome =>\n    isOutcomeUnlocked(\n      outcome,\n      state.maleSceneProgress,\n      state.femaleSceneProgress\n    )\n  );\n}",
    "function unlockedAdultOutcomes(scene = state.adultScene) {\n  const corePositions = (scene?.positions || []).filter(position =>\n    !isWarmupPosition(position) && !isBonusPosition(position)\n  );\n  const coreVisitedCount = corePositions.filter(position =>\n    state.adultVisitedPositionIds.has(position.id)\n  ).length;\n\n  return (scene?.outcomes || []).filter(outcome =>\n    canUnlockOutcome({\n      outcome,\n      climaxProgress: state.adultClimaxProgress,\n      coreVisitedCount,\n      corePlaySeconds: state.adultCorePlaySeconds\n    })\n  );\n}",
    'outcome gate'
)

replace_once(
    "  const outcomeTarget = (scene?.outcomes || [])\n    .filter(outcome => Number(outcome.unlockProgress || 82) > flow + 0.001)\n    .sort((a, b) => Number(a.unlockProgress) - Number(b.unlockProgress))[0];",
    "  const outcomeTarget = (scene?.outcomes || [])\n    .filter(outcome => Number(outcome.unlockProgress || 82) > state.adultClimaxProgress + 0.001)\n    .sort((a, b) => Number(a.unlockProgress) - Number(b.unlockProgress))[0];",
    'outcome discovery uses climax'
)

replace_once(
    "  els.adultFlowStatus.textContent =\n    `Lust %${Math.round(flow)} · combo ${state.adultComboCount}`;",
    "  els.adultFlowStatus.textContent =\n    `Lust %${Math.round(flow)} · Final %${Math.round(state.adultClimaxProgress)} · combo ${state.adultComboCount}`;",
    'flow status'
)

replace_once(
    "    Math.floor(flow),\n    unlockedCore.map(item => item.id).join(','),",
    "    Math.floor(flow),\n    Math.floor(state.adultClimaxProgress),\n    Math.floor(state.adultCorePlaySeconds),\n    unlockedCore.map(item => item.id).join(','),",
    'ui signature climax fields'
)

old_gate = """        } else if (next) {\n          const remaining = Math.max(0, Math.ceil(next.progress - flow));\n          els.discoveryGateMeta.textContent =\n            `%${Math.round(next.progress)} Lust seviyesinde açılır · ${remaining} puan kaldı`;\n        }"""
new_gate = """        } else if (next) {\n          if (next.type === 'outcome') {\n            const remaining = Math.max(0, Math.ceil(next.progress - state.adultClimaxProgress));\n            els.discoveryGateMeta.textContent =\n              `Final hazırlığı %${Math.round(state.adultClimaxProgress)} · ${remaining} puan kaldı`;\n          } else {\n            const remaining = Math.max(0, Math.ceil(next.progress - flow));\n            els.discoveryGateMeta.textContent =\n              `%${Math.round(next.progress)} Lust seviyesinde açılır · ${remaining} puan kaldı`;\n          }\n        }"""
replace_once(old_gate, new_gate, 'discovery gate copy')

replace_once(
    "  state.maleSceneProgress = Math.min(100, state.maleSceneProgress + delta.male);\n  state.femaleSceneProgress = Math.min(100, state.femaleSceneProgress + delta.female);\n  renderAdultProgress();\n}\n\nfunction updateVariantButton(position)",
    "  state.maleSceneProgress = Math.min(100, state.maleSceneProgress + delta.male);\n  state.femaleSceneProgress = Math.min(100, state.femaleSceneProgress + delta.female);\n  if (!isWarmupPosition(position)) {\n    const climaxDelta = averageAdultProgress(delta.male, delta.female) * 0.8;\n    state.adultClimaxProgress = Math.min(100, state.adultClimaxProgress + climaxDelta);\n  }\n  renderAdultProgress();\n}\n\nfunction updateVariantButton(position)",
    'selection climax progress'
)

replace_once(
    "  if (!outcome || !els.video) return;\n  if (!isOutcomeUnlocked(outcome, state.maleSceneProgress, state.femaleSceneProgress)) return;",
    "  if (!outcome || !els.video) return;\n  if (!unlockedAdultOutcomes(scene).some(item => item.id === outcome.id)) return;",
    'play outcome gate'
)

replace_once(
    "  state.femaleSceneProgress = Math.min(\n    100,\n    state.femaleSceneProgress + elapsed * Number(movement.femaleProgressRate || 1)\n  );\n  renderAdultProgress();\n\n  const outcomes = state.adultScene?.outcomes || [];\n  if (!outcomes.length && (state.maleSceneProgress >= 100 || state.femaleSceneProgress >= 100)) {\n    finishAdultScene();\n  }",
    "  state.femaleSceneProgress = Math.min(\n    100,\n    state.femaleSceneProgress + elapsed * Number(movement.femaleProgressRate || 1)\n  );\n  if (!isWarmupPosition(position)) {\n    const movementRate = averageAdultProgress(\n      Number(movement.maleProgressRate || 1),\n      Number(movement.femaleProgressRate || 1)\n    );\n    state.adultCorePlaySeconds += elapsed;\n    state.adultClimaxProgress = Math.min(\n      100,\n      state.adultClimaxProgress + elapsed * 0.9 * movementRate\n    );\n  }\n  renderAdultProgress();\n\n  const outcomes = state.adultScene?.outcomes || [];\n  if (\n    !outcomes.length &&\n    state.adultClimaxProgress >= 100 &&\n    state.adultCorePlaySeconds >= 18\n  ) {\n    finishAdultScene();\n  }",
    'playback climax progress and no-outcome finish gate'
)

path.write_text(text)
print('Applied separate Lust/climax final gate fix.')
