from pathlib import Path

# --- server: expose and cache terminal TTS quota exhaustion ---
p = Path('server.js')
s = p.read_text()

marker = "function pcmBase64ToWavBase64(pcmBase64, sampleRate = 24000) {"
helper = """
let ttsQuotaBlockedUntil = 0;

function ttsQuotaRetrySeconds(details) {
  const retry = String(details || '').match(/retry(?:Delay| in)?[^0-9]*(\\d+(?:\\.\\d+)?)s/i);
  if (retry) return Math.max(1, Math.ceil(Number(retry[1])));
  const human = String(details || '').match(/Please retry in\\s+(?:(\\d+)h)?(?:(\\d+)m)?(?:(\\d+(?:\\.\\d+)?)s)?/i);
  if (!human) return 0;
  return Math.max(1, Math.ceil((Number(human[1]) || 0) * 3600 + (Number(human[2]) || 0) * 60 + (Number(human[3]) || 0)));
}

function isTtsDailyQuotaError(details) {
  const text = String(details || '');
  return text.includes('generate_requests_per_model_per_day') ||
    (text.includes('RESOURCE_EXHAUSTED') && text.includes('gemini-3.1-flash-tts'));
}

"""
if 'let ttsQuotaBlockedUntil = 0;' not in s:
    if marker not in s: raise SystemExit('server marker missing')
    s = s.replace(marker, helper + marker, 1)

route_marker = "app.post('/api/gemini-dub-segment', async (req, res) => {\n  try {\n"
route_inject = """app.post('/api/gemini-dub-segment', async (req, res) => {
  try {
    if (ttsQuotaBlockedUntil > Date.now()) {
      return res.status(429).json({
        available: false,
        reason: 'GEMINI_TTS_DAILY_LIMIT',
        message: 'Gemini TTS günlük kotası doldu. Kota yenilendiğinde dublaj otomatik tekrar kullanılabilir.',
        retryAfterSeconds: Math.max(1, Math.ceil((ttsQuotaBlockedUntil - Date.now()) / 1000)),
        retryable: false
      });
    }
"""
if "reason: 'GEMINI_TTS_DAILY_LIMIT'" not in s:
    if route_marker not in s: raise SystemExit('dub route marker missing')
    s = s.replace(route_marker, route_inject, 1)

old_catch = """  } catch (error) {
    console.error('Gemini dub generation failed:', error);
    return res.status(502).json({
      available: false,
      reason: 'GEMINI_DUB_ERROR',
      message: 'Türkçe dublaj sesi üretilemedi.',
      error: error?.message || String(error)
    });
  }
});

app.get('/health'"""
new_catch = """  } catch (error) {
    console.error('Gemini dub generation failed:', error);
    const details = String(error?.message || error);
    if (isTtsDailyQuotaError(details)) {
      const retryAfterSeconds = ttsQuotaRetrySeconds(details) || 3600;
      ttsQuotaBlockedUntil = Date.now() + retryAfterSeconds * 1000;
      return res.status(429).json({
        available: false,
        reason: 'GEMINI_TTS_DAILY_LIMIT',
        message: 'Gemini 3.1 Flash TTS günlük 100 istek kotası doldu.',
        retryAfterSeconds,
        retryable: false
      });
    }
    return res.status(502).json({
      available: false,
      reason: 'GEMINI_DUB_ERROR',
      message: 'Türkçe dublaj sesi üretilemedi.',
      error: details
    });
  }
});

app.get('/health'"""
if "Gemini 3.1 Flash TTS günlük 100 istek kotası doldu." not in s:
    if old_catch not in s: raise SystemExit('dub catch marker missing')
    s = s.replace(old_catch, new_catch, 1)
p.write_text(s)

# --- client: stop request storm and show truthful state ---
p = Path('public/app.js')
s = p.read_text()
state_marker = "  dubSyncGeneration: 0,\n"
if 'dubUnavailableUntil' not in s:
    s = s.replace(state_marker, state_marker + "  dubUnavailableUntil: 0,\n  dubFailureReason: '',\n", 1)

ensure_marker = "async function ensureDubSegment(segment) {\n  if (!segment?.turkishText) return null;\n"
ensure_new = """async function ensureDubSegment(segment) {
  if (!segment?.turkishText) return null;
  if (state.dubUnavailableUntil > Date.now()) return null;
"""
if 'state.dubUnavailableUntil > Date.now()' not in s:
    if ensure_marker not in s: raise SystemExit('ensure marker missing')
    s = s.replace(ensure_marker, ensure_new, 1)

old_failure = """    if (!response.ok || !body?.available || !body?.audioBase64) {
      throw new Error(body?.error || body?.message || `HTTP ${response.status}`);
    }
"""
new_failure = """    if (!response.ok || !body?.available || !body?.audioBase64) {
      if (body?.reason === 'GEMINI_TTS_DAILY_LIMIT') {
        const retrySeconds = Math.max(60, Number(body.retryAfterSeconds) || 3600);
        state.dubUnavailableUntil = Date.now() + retrySeconds * 1000;
        state.dubFailureReason = 'GEMINI_TTS_DAILY_LIMIT';
        state.dubbingEnabled = false;
        stopDubPlayback();
        if (els.dubToggleBtn) {
          els.dubToggleBtn.textContent = `TR DUBLAJ: LİMİT DOLDU`;
          els.dubToggleBtn.classList.remove('hidden');
          els.dubToggleBtn.dataset.unavailable = 'true';
        }
        logEngineEvent('DUB_QUOTA_EXHAUSTED', { retrySeconds });
        return null;
      }
      throw new Error(body?.error || body?.message || `HTTP ${response.status}`);
    }
"""
if "DUB_QUOTA_EXHAUSTED" not in s:
    if old_failure not in s: raise SystemExit('client failure marker missing')
    s = s.replace(old_failure, new_failure, 1)

# Avoid burning daily quota by prefetching 3 utterances at once.
s = s.replace("nextDialogueSegments(state.dialogue?.segments || [], videoTime, 3)", "nextDialogueSegments(state.dialogue?.segments || [], videoTime, 1)")

reset_marker = "  state.activeDubSegmentId = null;\n}\n\nfunction prefetchDubSegmentsAround"
if "state.dubFailureReason = '';\n  state.dubUnavailableUntil = 0;" not in s:
    s = s.replace("  state.activeDubSegmentId = null;\n}\n\nfunction prefetchDubSegmentsAround", "  state.activeDubSegmentId = null;\n  state.dubFailureReason = '';\n  state.dubUnavailableUntil = 0;\n}\n\nfunction prefetchDubSegmentsAround", 1)

# Do not claim AÇIK if quota has been terminally rejected.
toggle_text = "`TR DUBLAJ: ${state.dubbingEnabled ? 'AÇIK' : 'KAPALI'}`"
# Existing listener may use this exact template; leave generic if absent.

p.write_text(s)

# --- CSS: final high-specificity fullscreen layout guard ---
p = Path('public/styles.css')
s = p.read_text()
css = r'''

/* VIDEOQUEST FULLSCREEN HUD FIX V5 — final cascade guard */
#playerSection .video-stage:fullscreen,
#playerSection .video-stage:-webkit-full-screen {
  position: fixed !important;
  inset: 0 !important;
  width: 100vw !important;
  height: 100dvh !important;
  max-height: none !important;
  overflow: hidden !important;
  border: 0 !important;
  border-radius: 0 !important;
  background: #000 !important;
}

#playerSection .video-stage:fullscreen #video,
#playerSection .video-stage:-webkit-full-screen #video {
  position: absolute !important;
  inset: 0 !important;
  width: 100% !important;
  height: 100% !important;
  min-height: 0 !important;
  max-height: none !important;
  object-fit: contain !important;
}

#playerSection .video-stage:fullscreen #dubToggleBtn,
#playerSection .video-stage:-webkit-full-screen #dubToggleBtn {
  position: absolute !important;
  z-index: 90 !important;
  top: max(10px, env(safe-area-inset-top)) !important;
  left: 12px !important;
  right: auto !important;
  bottom: auto !important;
  margin: 0 !important;
  min-height: 34px !important;
  padding: 6px 10px !important;
  font-size: 11px !important;
  border-radius: 10px !important;
}

#playerSection .video-stage:fullscreen #subtitleToggleBtn,
#playerSection .video-stage:-webkit-full-screen #subtitleToggleBtn {
  position: absolute !important;
  z-index: 90 !important;
  top: max(10px, env(safe-area-inset-top)) !important;
  left: 150px !important;
  right: auto !important;
  bottom: auto !important;
  margin: 0 !important;
}

#playerSection .video-stage:fullscreen #choices,
#playerSection .video-stage:-webkit-full-screen #choices {
  position: absolute !important;
  z-index: 60 !important;
  top: 56px !important;
  left: 12px !important;
  right: auto !important;
  bottom: 12px !important;
  width: min(43vw, 620px) !important;
  height: auto !important;
  max-height: calc(100dvh - 72px) !important;
  padding: 6px !important;
  display: flex !important;
  flex-direction: column !important;
  justify-content: flex-start !important;
  gap: 6px !important;
  overflow-y: auto !important;
  transform: none !important;
  border: 1px solid rgba(255,255,255,.09) !important;
  border-radius: 14px !important;
  background: rgba(4,8,12,.74) !important;
  backdrop-filter: blur(12px) !important;
  -webkit-backdrop-filter: blur(12px) !important;
}

#playerSection .video-stage:fullscreen #choices::before,
#playerSection .video-stage:fullscreen #choices::after,
#playerSection .video-stage:-webkit-full-screen #choices::before,
#playerSection .video-stage:-webkit-full-screen #choices::after,
#playerSection .video-stage:fullscreen #choices .choice::before,
#playerSection .video-stage:-webkit-full-screen #choices .choice::before {
  display: none !important;
}

#playerSection .video-stage:fullscreen #choices .choice,
#playerSection .video-stage:-webkit-full-screen #choices .choice {
  flex: 0 0 auto !important;
  width: 100% !important;
  min-height: 0 !important;
  margin: 0 !important;
  padding: 9px 30px 9px 11px !important;
  overflow: visible !important;
  border-radius: 11px !important;
}

#playerSection .video-stage:fullscreen #choices .choice-title,
#playerSection .video-stage:-webkit-full-screen #choices .choice-title {
  font-size: clamp(13px, 1.8vw, 18px) !important;
  line-height: 1.15 !important;
  white-space: normal !important;
  overflow-wrap: anywhere !important;
}

#playerSection .video-stage:fullscreen #choices .choice-meta,
#playerSection .video-stage:-webkit-full-screen #choices .choice-meta {
  margin-top: 3px !important;
  font-size: clamp(10px, 1.25vw, 13px) !important;
  line-height: 1.15 !important;
  white-space: normal !important;
}

#playerSection .video-stage:fullscreen #adultInteractionPanel,
#playerSection .video-stage:-webkit-full-screen #adultInteractionPanel {
  position: absolute !important;
  z-index: 70 !important;
  top: 56px !important;
  right: 12px !important;
  bottom: 12px !important;
  left: auto !important;
  width: min(50vw, 760px) !important;
  max-width: min(50vw, 760px) !important;
  max-height: calc(100dvh - 72px) !important;
  margin: 0 !important;
  padding: 9px !important;
  overflow-y: auto !important;
  border-radius: 14px !important;
  background: rgba(5,10,18,.90) !important;
  backdrop-filter: blur(12px) !important;
  -webkit-backdrop-filter: blur(12px) !important;
}

#playerSection .video-stage:fullscreen #adultInteractionPanel .position-tabs,
#playerSection .video-stage:-webkit-full-screen #adultInteractionPanel .position-tabs {
  flex-wrap: nowrap !important;
  overflow-x: auto !important;
  overflow-y: hidden !important;
}

#playerSection .video-stage:fullscreen #adultInteractionPanel .movement-choice-grid,
#playerSection .video-stage:-webkit-full-screen #adultInteractionPanel .movement-choice-grid {
  display: grid !important;
  grid-template-columns: repeat(2, minmax(0,1fr)) !important;
  gap: 6px !important;
  max-height: none !important;
  overflow: visible !important;
}

@media (orientation: portrait) {
  #playerSection .video-stage:fullscreen #choices,
  #playerSection .video-stage:-webkit-full-screen #choices {
    top: auto !important;
    left: 8px !important;
    right: 8px !important;
    bottom: 8px !important;
    width: auto !important;
    max-height: 46dvh !important;
  }
  #playerSection .video-stage:fullscreen #adultInteractionPanel,
  #playerSection .video-stage:-webkit-full-screen #adultInteractionPanel {
    top: auto !important;
    left: 8px !important;
    right: 8px !important;
    bottom: 8px !important;
    width: auto !important;
    max-width: none !important;
    max-height: 55dvh !important;
  }
}

#dubToggleBtn[data-unavailable="true"] {
  color: #ffd0d5 !important;
  border-color: rgba(255,90,110,.58) !important;
  background: rgba(62,8,17,.90) !important;
}
'''
if 'VIDEOQUEST FULLSCREEN HUD FIX V5' not in s:
    s += css
p.write_text(s)
