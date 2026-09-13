from pathlib import Path

# --- server.js: retry truncated/invalid Gemini JSON instead of failing a chunk ---
p = Path('server.js')
s = p.read_text()

# Storyboard generate+parse loop: parse inside retry loop and retry invalid JSON too.
old = '''    const ai = new GoogleGenAI({ apiKey });
  let response;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      response = await ai.models.generateContent({
        model: process.env.GEMINI_MODEL || "gemini-3.8-flash",
        contents: [{ role: "user", parts }],
        config: { responseMimeType: "application/json", temperature: 0.1 }
      });
      break;
    } catch (error) {
      const details = String(error?.message || error);
      const retryable = details.includes("503") || details.includes("UNAVAILABLE") || details.includes("high demand");
      if (!retryable || attempt === 4) throw error;
      await new Promise(resolve => setTimeout(resolve, attempt * 5000));
    }
  }

    const raw = String(response.text || '').trim();
    const parsed = JSON.parse(raw.replace(/^```json\\s*/i, '').replace(/\\s*```$/, ''));
'''
new = '''    const ai = new GoogleGenAI({ apiKey });
    let response;
    let parsed = null;
    let lastGenerationError = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        response = await ai.models.generateContent({
          model: process.env.GEMINI_MODEL || "gemini-3.8-flash",
          contents: [{ role: "user", parts }],
          config: {
            responseMimeType: "application/json",
            temperature: 0.1,
            maxOutputTokens: 16384
          }
        });
        const raw = String(response.text || '').trim();
        if (!raw) throw new Error('GEMINI_EMPTY_JSON_RESPONSE');
        parsed = JSON.parse(raw.replace(/^```json\\s*/i, '').replace(/\\s*```$/, ''));
        break;
      } catch (error) {
        lastGenerationError = error;
        const details = String(error?.message || error);
        const retryable =
          details.includes("503") ||
          details.includes("UNAVAILABLE") ||
          details.includes("high demand") ||
          details.includes("Unexpected end of JSON input") ||
          details.includes("GEMINI_EMPTY_JSON_RESPONSE");
        if (!retryable || attempt === 4) throw error;
        console.warn(`[gemini-storyboard-retry] attempt ${attempt}/4: ${details}`);
        await new Promise(resolve => setTimeout(resolve, attempt * 1800));
      }
    }
    if (!parsed) throw lastGenerationError || new Error('GEMINI_JSON_PARSE_FAILED');
'''
if old not in s:
    raise SystemExit('storyboard block not found')
s = s.replace(old, new, 1)

# Dialogue generation: retry invalid/truncated JSON and give it more output room.
old = '''      const response = await ai.models.generateContent({
        model: process.env.GEMINI_DIALOGUE_MODEL || 'gemini-3.8-flash',
        contents: [{
          role: 'user',
          parts: [
            {
              fileData: {
                fileUri: remoteFile.uri,
                mimeType: remoteFile.mimeType || req.file.mimetype
              }
            },
            { text: prompt + transcriptGrounding }
          ]
        }],
        config: {
          responseMimeType: 'application/json',
          temperature: 0.05
        }
      });

      const raw = String(response.text || '').trim();
      const parsed = JSON.parse(
        raw.replace(/^```json\\s*/i, '').replace(/```\\s*$/i, '')
      );
'''
new = '''      let parsed = null;
      let lastDialogueError = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const response = await ai.models.generateContent({
            model: process.env.GEMINI_DIALOGUE_MODEL || 'gemini-3.8-flash',
            contents: [{
              role: 'user',
              parts: [
                {
                  fileData: {
                    fileUri: remoteFile.uri,
                    mimeType: remoteFile.mimeType || req.file.mimetype
                  }
                },
                { text: prompt + transcriptGrounding }
              ]
            }],
            config: {
              responseMimeType: 'application/json',
              temperature: 0.05,
              maxOutputTokens: 16384
            }
          });
          const raw = String(response.text || '').trim();
          if (!raw) throw new Error('GEMINI_EMPTY_JSON_RESPONSE');
          parsed = JSON.parse(
            raw.replace(/^```json\\s*/i, '').replace(/```\\s*$/i, '')
          );
          break;
        } catch (error) {
          lastDialogueError = error;
          const details = String(error?.message || error);
          const retryable =
            details.includes('Unexpected end of JSON input') ||
            details.includes('GEMINI_EMPTY_JSON_RESPONSE') ||
            details.includes('503') ||
            details.includes('UNAVAILABLE') ||
            details.includes('high demand');
          if (!retryable || attempt === 3) throw error;
          console.warn(`[gemini-dialogue-retry] attempt ${attempt}/3: ${details}`);
          await wait(attempt * 1400);
        }
      }
      if (!parsed) throw lastDialogueError || new Error('GEMINI_DIALOGUE_JSON_PARSE_FAILED');
'''
if old not in s:
    raise SystemExit('dialogue block not found')
s = s.replace(old, new, 1)
p.write_text(s)

# --- public/app.js: page refresh is always a fresh game ---
p = Path('public/app.js')
s = p.read_text()

# Do not persist new game/session artifacts to localStorage.
s = s.replace("    localStorage.setItem(RUNTIME_SAVE_KEY, JSON.stringify(snapshot));", "    // Session persistence intentionally disabled: refresh must start clean.\n    return;", 1)
s = s.replace("    localStorage.setItem(\n      'videoquest:last-dialogue',\n      JSON.stringify(state.dialogue)\n    );", "    // Dialogue persistence intentionally disabled: refresh must start clean.\n    localStorage.removeItem('videoquest:last-dialogue');", 1)
s = s.replace('    localStorage.setItem("videoquest:last-analysis", JSON.stringify(normalized));', '    // Analysis persistence intentionally disabled: refresh must start clean.\n    localStorage.removeItem("videoquest:last-analysis");', 1)

# Replace restore-on-load with an explicit purge of all prior game residue.
old = '''restoreSavedAnalysis();
'''
new = '''function clearPreviousGameResidue() {
  localStorage.removeItem('videoquest:last-analysis');
  localStorage.removeItem('videoquest:last-dialogue');
  localStorage.removeItem(RUNTIME_SAVE_KEY);
  sessionStorage.removeItem('videoquest:last-analysis');
  sessionStorage.removeItem('videoquest:last-dialogue');
  sessionStorage.removeItem(RUNTIME_SAVE_KEY);
  state.analysis = null;
  state.dialogue = null;
  state.analysisFingerprint = '';
  state.integrityReport = null;
  state.consumedActionIds = new Set();
  state.currentActionIndex = -1;
  state.gameCursorTime = 0;
  state.adultScenes = [];
  state.completedAdultSceneIds = new Set();
  state.adultVisitedPositionIds = new Set();
  state.adultMovementPlayCounts = new Map();
  state.adultPreludePlayCounts = new Map();
  state.adultRevealedPositionIds = new Set();
  state.adultUnlockedOutcomeIds = new Set();
  state.adultMode = false;
  state.adultScene = null;
  state.activeAction = null;
  state.activePositionId = null;
  state.activeMovementId = null;
  state.engineEvents = [];
  els.choices.innerHTML = '';
  els.timelineList.innerHTML = '';
  els.videoPrompt.textContent = '';
  els.adultInteractionPanel?.classList.add('hidden');
  els.playerSection?.classList.add('hidden');
  els.analysisCard?.classList.add('hidden');
  if (els.video) {
    els.video.pause();
    els.video.removeAttribute('src');
    els.video.load();
  }
  resetDubState();
  setGameState('IDLE');
}

clearPreviousGameResidue();
'''
if old not in s:
    raise SystemExit('restore call not found')
s = s.replace(old, new, 1)
p.write_text(s)
