# VideoQuest v2 implementation report — #144

## Result

Narrative observations now survive scene references. One immutable evidence graph
feeds one pure gameplay reducer, the cancellable media adapter and a single UI
projection. Stage ownership no longer depends on the old scene filter. Verified
choice engagement drives character, relationship and Lust progress; source time,
visual continuity and unlocks are separate concepts.

See [architecture and migration contracts](videoquest-v2-architecture.md) for the
source-to-player analysis, formulas, evidence contract, save migration and limits.
The development branch includes upstream main
`89fa1616a968c9f660c565eb4c8742fba819fde8`, including PRs #145–#147.

## Validation

Local validation on 2026-10-12, Node 24.19.0, system Chromium and FFmpeg:

| Check | Actual result |
| --- | --- |
| Clean dependency installation | `npm ci` succeeded; 182 packages; codec build and extractor checksum passed |
| Production syntax (`npm run check`, included in `npm test`) | 86 files passed |
| `npm test` | 1099 tests passed, 0 failed, 0 skipped, 0 cancelled; 55.46 seconds |
| `npm run test:browser` | 8 passed, 0 failed; desktop and Pixel 7 / Android emulation |
| Existing saved-game browser smoke | Passed URL/upload save, browser restart, local replay, backup/restore, deletion confirmation and mobile width; zero paid API calls |
| `node test/metrics/gameplay-v2.mjs` | Completed; results below |
| `git diff --check` | Passed |

These are local results. GitHub Actions results are reported separately in the PR.

The original baseline `60f275325c3a6e455fa6c2f196fff37d410791d3` ran 1062 tests:
1061 passed and one failed. The failure exposed a media-cache verification race;
verification is now published before releasing the in-flight hash operation.
The existing concurrency test passes without weakening its assertion.

The full suite includes frozen historical v1 tests. Those tests are reference
coverage, **not v2 acceptance**. V2 has 22 dedicated reducer/evidence/media-adapter
tests, a saved-game payload round trip, and eight real-browser acceptance runs
(four scenarios on desktop and Android emulation). Browser tests serve the actual
application with generated neutral video and test-only fixture injection.

## Measured synthetic before/after results

Run `node test/metrics/gameplay-v2.mjs` to reproduce. These compare frozen v1
functions with v2 on the same declared observations, not unseen source footage.

| Fixture | Before | After |
| --- | --- | --- |
| Seven narrative observations: initial visible cards | 0 | 3 (all 7 retained in graph) |
| Five actions, six source clips: distinct cards | 2 | 5 |
| Incorrectly conflated cards | 1 | 0 |
| Verified source coverage | 36 seconds | 36 seconds |
| Incompatible earlier replay candidates | 1 | 0 |
| Two-choice, 14.4s scene; selections A,A,A,B | 50,50,50,100 | 50,75,75,100 |

Duplicate clip IDs after compilation: 0. Real-video mismatch count is unmeasured;
no claim of visual recognition accuracy is made from synthetic fixtures.

## Changed and retired files

Status is relative to the integrated upstream main. `R` entries were removed from
production and retained only as test references. This report itself is also new.

```text
M	.github/workflows/reliability-tests.yml
M	.gitignore
A	docs/videoquest-v2-architecture.md
M	lib/turkish-media/cache.js
M	package-lock.json
M	package.json
A	playwright.config.js
M	public/adult-gameplay.js
M	public/app.js
A	public/gameplay-evidence.js
A	public/gameplay-player.js
A	public/gameplay-state.js
A	public/gameplay-view.js
M	public/index.html
A	public/progression-pacing.js
M	public/saved-games.js
M	server.js
M	test/adult-runtime-occurrence.test.js
A	test/browser/gameplay.spec.js
A	test/browser/server.mjs
M	test/character-identity.test.js
M	test/conversation-timing.test.js
A	test/fixtures/gameplay-v2.js
A	test/fixtures/legacy-gameplay-reference.txt
R097	public/interaction-compat.js	test/fixtures/legacy-interaction-compat.js
R096	public/interaction-completion.js	test/fixtures/legacy-interaction-completion.js
R099	public/interaction-engine.js	test/fixtures/legacy-interaction-engine.js
A	test/gameplay-v2-player.test.js
A	test/gameplay-v2.test.js
M	test/general-integrity.test.js
M	test/interaction-budget.test.js
M	test/interaction-compat.test.js
M	test/interaction-completion.test.js
M	test/interaction-engine.test.js
M	test/interaction-integration.test.js
A	test/metrics/gameplay-v2.mjs
M	test/panel-playback.test.js
M	test/player-navigation.test.js
M	test/saved-games.test.js
```

The three retired interaction modules have no production importers. The old
runtime in `app.js` was removed rather than left as an alternate execution path.
Its frozen test reference supports historical assertions and before/after metrics.
`prepareAdultScenes` remains for analysis diagnostics; the primary report graph
is the actual gameplay graph and the historical composition is named explicitly.

Removed top-level app functions (74):

```text
addFemaleLust
adultFrameLoop
adultTimeLabel
adultWarmupStats
applyAdultPreludeProgress
applyAdultSelectionProgress
beginAdultSelection
clearPanelPlaybackRecovery
commitAdultSelectionProgress
continueAfterAdultOrgasm
currentAdultFlow
currentWarmupLustScale
enterAdultScene
findAdultSceneAt
finishAction
finishAdultScene
futureActions
genericConversationEnd
genericInteractionScene
genericInteractionSnapshot
guardPlayable
handleAdultRhythmTap
handleSourceEnded
isUnownedTimelineChoice
navigateTimelineTo
nextAdultDiscovery
nextEnergeticPositionMovement
nextVerifiedRouteTime
observeInteractionProgress
openAdultOrgasmDecision
orderedLockedAdultPositions
persistRuntimeSnapshot
playAction
playAdultOutcome
playAdultPrelude
playNextAdultVariant
reconcileInteractionSeek
reconcileInteractionSource
refreshAdultCompactDock
remainingPositionControlClips
renderAdultApproachChoices
renderAdultFlowStatus
renderAdultOutcomes
renderAdultPanel
renderAdultProgress
renderAdultProgressiveUI
renderAdultWarmupChoices
renderInteractionInterludeChoices
resetAdultSceneGameplay
resetAdultTapRhythm
resetGameAtAction
restoreRuntimeSnapshot
resumeActionPlayback
resumeAnalysisGap
resumePanelPlayback
resumeSourceVideo
seekAdultLoop
selectAdultCategory
selectAdultMovement
selectAdultPosition
selectMovementTempoVariant
setAdultMachinePhase
settleInteractionClipBoundary
showPanelPlaybackRecovery
showPlaybackRecovery
skipCurrentScene
tempoLabel
triggerAdultOrgasmDecision
unlockNextAdultPositionFromLust
unlockedAdultOutcomes
unlockedAdultPositions
updateAdultPlayback
updateRhythmControl
updateVariantButton
```

Removed obsolete app state fields (41):

```text
activeAdultOccurrenceId
activeAdultCategory
activeAdultPartnerTrackId
activeMovementChoiceId
maleSceneProgress
femaleSceneProgress
adultMaleOrgasmProgress
adultFemaleOrgasmProgress
adultMaleOrgasmCount
adultFemaleOrgasmCount
adultOrgasmDecision
adultPlayedOutcomeIds
adultSexUnlocked
adultUnlockedPositionIds
lastAdultMediaTime
adultSeekTimer
adultSeekListener
adultSeekRequestId
adultSelectionToken
adultPendingSelectionProgress
adultComboCount
adultClimaxProgress
adultCorePlaySeconds
adultTimelineFloor
adultLastApproachRefreshAt
adultOutcomePhase
activeAdultOutcomeId
activeAdultPreludeId
adultUiSignature
adultLastUiPhase
lastAdultFrameNow
adultFrameRequest
restoredAdultSceneId
adultTapTimes
adultTapTempo
adultTapCandidateTempo
adultTapCandidateCount
adultLastTempoSwitchAt
adultFireHeld
adultFireArmed
adultAwaitingFire
```

## Remaining limitations

- Verified semantics and visual facts still depend on provider/source evidence.
  The runtime cannot detect an incorrect observation by examining video pixels.
  Old analyses without v2 facts retain verified legacy labels; generic or
  unverified v2 semantics use a timestamped source caption.
- Progress weights are deterministic game rules, not measurements of emotion.
  Source snippets without branch evidence remain a chronological route.
- Android testing uses Chromium device emulation. Physical Android, iOS/Safari,
  native fullscreen behavior and device-specific decoder paths require hardware
  validation.
- Paid Gemini and ElevenLabs requests were not made during validation. Existing
  provider, media and Turkish audio regression suites pass, but that does not
  establish current external-service availability or source-specific output quality.
- Saves without a compatible v2 graph snapshot keep their media, analysis and dub
  and start fresh gameplay. Old runtime progress is not guessed or replayed.

No main merge or Render deployment is part of this change.
