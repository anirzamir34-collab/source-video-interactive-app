# VideoQuest v2 reconstruction — Issue #144

## Baseline and source-to-player map (before implementation)

Baseline main: `60f275325c3a6e455fa6c2f196fff37d410791d3`.
Inventory: 86 Node test files, one Python extractor suite invoked by Node,
media/HTTP integration tests and standalone browser smoke scripts. The commit
message claims 1062 passing tests; the actual local run is recorded separately.

`server.js` generates and validates source observations. `normalizeAnalysis`
normalizes times/identities, partitions protagonist ownership and binds story
relationships. `prepareAdultScenes` classifies verified source intervals and
composes encounter references. The old renderer then separately filters story
ownership, creates an interaction runtime and mutates numerous host fields.
`sceneOwnsStoryChoice` removes referenced story observations from `futureActions`.
The interaction budget mixes coverage and selection; legacy fields and runtime
both write progress/unlocks. Choice grouping can merge distinct origins solely
because they share tempo. Saved-game payloads retain analysis but omit gameplay.

The media client independently synchronizes Turkish audio/subtitles to the video
clock. This boundary, existing source upload, provider APIs and IndexedDB media
stores must stay intact. No source footage or private analysis is a test fixture.

## Replacement contracts

1. `gameplay-evidence.js`: immutable versioned evidence graph, explicit chapter,
   stage, cast, source identity, observed action semantics and visual facts.
   Unknown facts stay unknown. Story references never consume narrative nodes.
2. `gameplay-state.js`: pure `gameplayReducer(state,event)` and selectors
   `availableChoices`, `activeSurface`, `nextPlayableClip`, `progression`.
   Confirmed playback earns bounded, diminishing engagement; selection/seek,
   clock passage, unlock and restoration cannot manufacture rewards.
3. `gameplay-player.js`: cancellable media effects, sequence boundaries and
   recoverable failures. It feeds observed playback to the reducer; it does not
   decide progression. Video time remains authoritative for dubbed audio.
4. `gameplay-view.js`: cards and a single visible surface projected from state;
   fullscreen uses the same DOM and controller. Existing media UI stays intact.
5. Versioned snapshots bind to the graph fingerprint, preserve earned choices,
   and restore paused at a decision without replaying rewards. Old saves open
   their existing analysis/media with fresh gameplay when no snapshot exists.

Continuity is conservative: verified changes retire incompatible earlier states;
explicit rewind reconstructs visual context while retaining reward history.
Unverified semantic headlines abstain to a timestamped source clip. Cut-separated
clips group only with matching source action, occurrence, cast and semantics.
Unlocks only reveal same-chapter successors at a choice boundary, never auto-seek.

## Implemented behavior and limits

The reducer is the only live owner of stage progress, selection counters,
characters, relationships, visual context and stage/chapter transitions.
`app.js` retains acquisition, analysis, the media client, saved-game orchestration
and a projection of game status for existing UI. `prepareAdultScenes` remains an
analysis diagnostic; its legacy grouping is exported as `legacyComposition`.
The report's primary `graph` is now the actual v2 graph used by the player.

The compiler accepts verified numeric intervals with confidence >= 0.6. It keeps
original source start/end, provenance, chapter, occurrence and cast. The optional
`gameplayEvidence.version = 2` extension is normalized on both server and client.
Explicit observed labels override contradictory headlines. Unknown/generic-only
labels use a timestamped source-clip caption. Old records retain their verified
legacy labels; the client cannot independently establish their visual accuracy.

Story stages keep distinct meaningful intents. Without fork evidence, dialogue
observations become a chronological route rather than fabricated alternatives.
No encounter reference consumes a narrative observation. Chapters are ordered
source runs separated by declared identity, cast, story/interaction boundaries
or a >45s evidence gap. Stage order follows observed source chronology; explicit
chapter navigation is separate from automatic stage unlocking.

Progress per engagement is `100 / min(4, stageChoiceCount) * 0.5^previousPlays`.
A selected action must accumulate `min(3s, 65% of its first played clip)` of real
playback before receiving a reward. This is engagement, not a claim that the
whole clip was watched. Seeks, rejected playback, duplicate samples and stale
operations do not award credit. A single repeated choice is capped at 75% while
alternatives remain. Progress can unlock a successor, but moving to it requires
a choice boundary and an explicit button. Skipping does not mint progress.
Character/relationship progress uses the same engagement event. Relationship
labels remain facts from the existing verified identity binding; the numeric
interaction score does not invent a relationship or a character's emotions.

Visual facts include location, appearance, clothing, posture and scene state;
per-person keys support stable track IDs. Earlier replay requires positive
compatibility with observed facts. Verified before/after facts form a temporal
partial order through `visualTime`; explicit rewind rebuilds earlier context
without clearing reward history. Unknown visual facts remain unknown. This is
not a computer-vision model and cannot detect missing/incorrect provider facts.

The player owns cancellable seek/play effects and source-cut sequencing. It
retains source/dub sentence-boundary waiting for story playback. Progress,
source coverage and visual completion are separate: reaching a clip boundary
without sufficient observed playback does not confirm its visual aftermath.
Existing subtitle and dubbing listeners continue to synchronize to the real
HTML video clock. Fullscreen uses the same mounted panel, not a second runtime.

Snapshots are versioned and graph-fingerprint-bound. They preserve bounded
scores, validated source choice counters and visual evidence references, restore
paused, and do not replay rewards. Old records without a v2 snapshot retain
video, analysis and Turkish media and begin a fresh game. Unsupported/fingerprint
mismatches reset gameplay only; no saved media or caches are deleted.

## Removed live paths and regression references

The old `futureActions`/scene ownership filter, mutable encounter progression,
phase reconciliation, per-frame progress loop and separate timeline selection
handlers were removed from `app.js`. 41 obsolete state fields were also removed.
The three retired runtime modules were moved out of `public/` into clearly named
`test/fixtures/legacy-*` reference modules. No production import references them.
The tiny legacy pacing helper used by analysis diagnostics is separate.

Existing tests that extracted retired handlers now explicitly read a frozen
v1 reference fixture. They retain historical regression evidence and the
before/after metric baseline; they do **not** validate v2. New v2 acceptance is
in `test/gameplay-v2*.test.js`, the saved-game round trip test and
`test/browser/gameplay.spec.js`, which boots the real application with synthetic
media and test-only response injection. No testing backdoor exists in `public/`.

## Reproducing validation

- `npm ci`
- `npm run check`
- `npm test`
- `npm run test:browser` (Chromium and FFmpeg required)
- `node test/metrics/gameplay-v2.mjs`

The managed environment's setup script additionally selects Node's configured
proxy and the pinned yt-dlp release, uses `/workspace/.npm` and verifies the
extractor checksum. These environment adaptations are not application settings.
CI runs Node/HTTP/media tests plus desktop/Android Chromium acceptance and saves
browser traces on failure. No workflow added by this change deploys the app.

Latest upstream `89fa1616a968c9f660c565eb4c8742fba819fde8` was merged into the
feature branch before final testing. Gemini pacing/quota recognition and staged
media recovery from PRs #145–#147 are preserved.
