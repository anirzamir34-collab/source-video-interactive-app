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
