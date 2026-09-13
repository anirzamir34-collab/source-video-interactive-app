from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: expected 1 match, got {count}')
    return text.replace(old, new, 1)

engine_path = Path('public/engine-hardening.js')
engine = engine_path.read_text()
engine = replace_once(
    engine,
    "  state.activeMovementId = snapshot.activeMovementId || null;\n  return state;",
    "  state.activeMovementId = snapshot.activeMovementId || null;\n  state.restoredAdultSceneId = snapshot.adultSceneId || null;\n  return state;",
    'restore adult scene id'
)
engine_path.write_text(engine)

app_path = Path('public/app.js')
app = app_path.read_text()
app = replace_once(
    app,
    "  lastRuntimeSaveAt: 0,\n};",
    "  lastRuntimeSaveAt: 0,\n  restoredAdultSceneId: null,\n};",
    'runtime restored scene state'
)
app = replace_once(
    app,
    "  if (previousSceneId !== scene.id) {\n    resetAdultSceneGameplay();\n    state.activePositionId = null;\n    state.activeAdultCategory = null;\n    state.activeMovementId = null;\n  }\n\n  state.adultScene = scene;",
    "  const restoringSameScene = state.restoredAdultSceneId === scene.id;\n  if (previousSceneId !== scene.id && !restoringSameScene) {\n    resetAdultSceneGameplay();\n    state.activePositionId = null;\n    state.activeAdultCategory = null;\n    state.activeMovementId = null;\n  }\n  if (restoringSameScene) {\n    state.restoredAdultSceneId = null;\n    logEngineEvent('ADULT_SCENE_RUNTIME_RESTORED', { sceneId: scene.id });\n  }\n\n  state.adultScene = scene;",
    'render adult restore guard'
)
app = replace_once(
    app,
    "    if (scene) {\n      resetAdultSceneGameplay();\n      state.lastAdultFrameNow = now;\n      renderAdultPanel(scene);\n    }",
    "    if (scene) {\n      if (state.restoredAdultSceneId !== scene.id) {\n        resetAdultSceneGameplay();\n      }\n      state.lastAdultFrameNow = now;\n      renderAdultPanel(scene);\n    }",
    'playback adult restore guard'
)
app_path.write_text(app)

# Strengthen runtime snapshot test.
test_path = Path('test/engine-hardening.test.js')
test = test_path.read_text()
test = replace_once(
    test,
    "    adultComboCount: 2, adultPhaseMachine: 'positions', adultLastUiPhase: 'positions'\n  };",
    "    adultComboCount: 2, adultPhaseMachine: 'positions', adultLastUiPhase: 'positions',\n    adultScene: { id: 'scene-active' }\n  };",
    'snapshot fixture scene'
)
test = replace_once(
    test,
    "  assert.equal(target.adultMovementPlayCounts.get('m1'), 2);\n});",
    "  assert.equal(target.adultMovementPlayCounts.get('m1'), 2);\n  assert.equal(target.restoredAdultSceneId, 'scene-active');\n});",
    'snapshot restore assertion'
)
test_path.write_text(test)

print('Adult-scene runtime resume preservation applied.')
