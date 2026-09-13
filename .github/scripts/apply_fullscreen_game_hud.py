from pathlib import Path

path = Path('public/styles.css')
css = path.read_text()
marker = '/* VIDEOQUEST FULLSCREEN HUD V4 */'
if marker in css:
    raise SystemExit('fullscreen HUD V4 already present')

css += r'''

/* VIDEOQUEST FULLSCREEN HUD V4 */
/* Keep every interactive control inside the fullscreen video stage. */
.video-stage:fullscreen,
.video-stage:-webkit-full-screen {
  width: 100vw !important;
  height: 100dvh !important;
  min-height: 100dvh !important;
  max-height: none !important;
  margin: 0 !important;
  border: 0 !important;
  border-radius: 0 !important;
  overflow: hidden !important;
  background: #000 !important;
}

.video-stage:fullscreen > video,
.video-stage:-webkit-full-screen > video {
  position: absolute !important;
  inset: 0 !important;
  width: 100% !important;
  height: 100% !important;
  min-height: 0 !important;
  max-height: none !important;
  object-fit: contain !important;
  border-radius: 0 !important;
}

/* Adult/special choices become a compact right-side game HUD in landscape. */
.video-stage:fullscreen .adult-interaction-panel,
.video-stage:-webkit-full-screen .adult-interaction-panel {
  position: absolute !important;
  top: max(62px, env(safe-area-inset-top)) !important;
  right: max(10px, env(safe-area-inset-right)) !important;
  bottom: max(10px, env(safe-area-inset-bottom)) !important;
  left: auto !important;
  z-index: 90 !important;
  width: min(40vw, 440px) !important;
  max-width: 440px !important;
  height: auto !important;
  max-height: calc(100dvh - 76px) !important;
  margin: 0 !important;
  padding: 10px !important;
  overflow-x: hidden !important;
  overflow-y: auto !important;
  overscroll-behavior: contain !important;
  scrollbar-width: thin !important;
  border: 1px solid rgba(83, 242, 190, .30) !important;
  border-radius: 16px !important;
  background: linear-gradient(155deg, rgba(5, 13, 18, .90), rgba(5, 9, 13, .78)) !important;
  box-shadow: 0 18px 55px rgba(0, 0, 0, .52) !important;
  backdrop-filter: blur(16px) saturate(125%) !important;
  -webkit-backdrop-filter: blur(16px) saturate(125%) !important;
  pointer-events: auto !important;
}

.video-stage:fullscreen .adult-panel-header,
.video-stage:-webkit-full-screen .adult-panel-header,
.video-stage:fullscreen .adult-stage-summary,
.video-stage:-webkit-full-screen .adult-stage-summary {
  gap: 7px !important;
  margin-bottom: 7px !important;
}

.video-stage:fullscreen .adult-panel-header h3,
.video-stage:-webkit-full-screen .adult-panel-header h3,
.video-stage:fullscreen .adult-phase-copy strong,
.video-stage:-webkit-full-screen .adult-phase-copy strong {
  font-size: .78rem !important;
  line-height: 1.15 !important;
}

.video-stage:fullscreen .adult-phase-copy small,
.video-stage:-webkit-full-screen .adult-phase-copy small,
.video-stage:fullscreen .adult-panel-kicker,
.video-stage:-webkit-full-screen .adult-panel-kicker,
.video-stage:fullscreen .adult-scene-time,
.video-stage:-webkit-full-screen .adult-scene-time,
.video-stage:fullscreen .adult-flow-status,
.video-stage:-webkit-full-screen .adult-flow-status {
  font-size: .60rem !important;
  line-height: 1.2 !important;
}

.video-stage:fullscreen .scene-progress-bars,
.video-stage:-webkit-full-screen .scene-progress-bars {
  gap: 5px !important;
  margin: 6px 0 !important;
}

.video-stage:fullscreen .adult-discovery-gate,
.video-stage:-webkit-full-screen .adult-discovery-gate {
  padding: 7px !important;
  margin: 6px 0 !important;
}

.video-stage:fullscreen .choice-section-heading,
.video-stage:-webkit-full-screen .choice-section-heading {
  margin: 6px 0 4px !important;
  font-size: .64rem !important;
}

.video-stage:fullscreen .discovery-choice-grid,
.video-stage:-webkit-full-screen .discovery-choice-grid,
.video-stage:fullscreen .movement-choice-grid,
.video-stage:-webkit-full-screen .movement-choice-grid,
.video-stage:fullscreen .outcome-choice-grid,
.video-stage:-webkit-full-screen .outcome-choice-grid {
  display: grid !important;
  grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
  gap: 6px !important;
  max-height: none !important;
  overflow: visible !important;
}

.video-stage:fullscreen .position-tabs,
.video-stage:-webkit-full-screen .position-tabs,
.video-stage:fullscreen .category-tabs,
.video-stage:-webkit-full-screen .category-tabs {
  display: flex !important;
  flex-wrap: wrap !important;
  gap: 5px !important;
  max-height: none !important;
  overflow: visible !important;
}

.video-stage:fullscreen .discovery-choice-card,
.video-stage:-webkit-full-screen .discovery-choice-card,
.video-stage:fullscreen .movement-choice-card,
.video-stage:-webkit-full-screen .movement-choice-card,
.video-stage:fullscreen .position-tab,
.video-stage:-webkit-full-screen .position-tab,
.video-stage:fullscreen .category-tab,
.video-stage:-webkit-full-screen .category-tab,
.video-stage:fullscreen .outcome-choice-card,
.video-stage:-webkit-full-screen .outcome-choice-card {
  min-width: 0 !important;
  min-height: 0 !important;
  height: auto !important;
  padding: 7px 8px !important;
  font-size: .68rem !important;
  line-height: 1.15 !important;
}

.video-stage:fullscreen .finish-adult-scene-btn,
.video-stage:-webkit-full-screen .finish-adult-scene-btn,
.video-stage:fullscreen .next-variant-btn,
.video-stage:-webkit-full-screen .next-variant-btn {
  min-height: 34px !important;
  height: auto !important;
  margin-top: 6px !important;
  padding: 7px 9px !important;
  font-size: .66rem !important;
}

/* Ordinary story choices stay in the lower-left so they do not fight the adult HUD. */
.video-stage:fullscreen .choices-overlay,
.video-stage:-webkit-full-screen .choices-overlay {
  right: auto !important;
  left: max(12px, env(safe-area-inset-left)) !important;
  bottom: max(12px, env(safe-area-inset-bottom)) !important;
  width: min(44vw, 520px) !important;
  max-width: 520px !important;
  max-height: 44dvh !important;
  margin: 0 !important;
  z-index: 85 !important;
}

.video-stage:fullscreen .game-hud,
.video-stage:-webkit-full-screen .game-hud {
  top: max(10px, env(safe-area-inset-top)) !important;
  left: max(10px, env(safe-area-inset-left)) !important;
  right: auto !important;
  width: auto !important;
  max-width: min(48vw, 430px) !important;
  z-index: 82 !important;
}

/* Put the fullscreen exit control above the right HUD. */
.video-stage:fullscreen .fullscreen-btn,
.video-stage:-webkit-full-screen .fullscreen-btn {
  top: max(10px, env(safe-area-inset-top)) !important;
  right: max(10px, env(safe-area-inset-right)) !important;
  z-index: 110 !important;
}

/* Phones that fail to rotate use a bottom-sheet layout instead of covering the full picture. */
@media (orientation: portrait) {
  .video-stage:fullscreen .adult-interaction-panel,
  .video-stage:-webkit-full-screen .adult-interaction-panel {
    top: auto !important;
    right: max(8px, env(safe-area-inset-right)) !important;
    bottom: max(8px, env(safe-area-inset-bottom)) !important;
    left: max(8px, env(safe-area-inset-left)) !important;
    width: auto !important;
    max-width: none !important;
    max-height: 45dvh !important;
  }

  .video-stage:fullscreen .choices-overlay,
  .video-stage:-webkit-full-screen .choices-overlay {
    right: max(8px, env(safe-area-inset-right)) !important;
    left: max(8px, env(safe-area-inset-left)) !important;
    width: auto !important;
    max-width: none !important;
    max-height: 38dvh !important;
  }
}

@media (orientation: landscape) and (max-height: 520px) {
  .video-stage:fullscreen .adult-interaction-panel,
  .video-stage:-webkit-full-screen .adult-interaction-panel {
    top: 54px !important;
    width: min(44vw, 390px) !important;
    max-height: calc(100dvh - 64px) !important;
    padding: 8px !important;
  }

  .video-stage:fullscreen .adult-phase-copy small,
  .video-stage:-webkit-full-screen .adult-phase-copy small,
  .video-stage:fullscreen .adult-discovery-gate,
  .video-stage:-webkit-full-screen .adult-discovery-gate {
    display: none !important;
  }
}
'''

path.write_text(css)
