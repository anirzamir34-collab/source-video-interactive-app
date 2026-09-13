from pathlib import Path
import re


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one exact match, got {count}")
    return text.replace(old, new, 1)


def sub_once(text, pattern, replacement, label, flags=0):
    updated, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise RuntimeError(f"{label}: expected one replacement, got {count}")
    return updated


path = Path('public/app.js')
app = path.read_text()

app = replace_once(
    app,
    "} from './adult-gameplay.js';\n\nconst $ = (id) => document.getElementById(id);",
    "} from './adult-gameplay.js';\nimport {\n  dialogueSegmentAt,\n  dubSegmentKey,\n  fittedDubPlaybackRate,\n  isCompleteChunkAnalysis,\n  mapVideoTimeToDubTime,\n  nextDialogueSegments\n} from './playback-logic.js';\n\nconst $ = (id) => document.getElementById(id);",
    'add playback helpers import'
)

app = sub_once(
    app,
    r"const dubAudio = new Audio\(\);.*?els\.video\.addEventListener\('play', \(\) => \{\n  void syncDubPlayback\(\);\n  prefetchDubAround\(Number\(els\.video\.currentTime\) \|\| 0\);\n\}\);",
    '''const dubAudio = new Audio();
dubAudio.preload = 'auto';

function getDubSegmentAt(videoTime) {
  return dialogueSegmentAt(state.dialogue?.segments || [], videoTime);
}

function getDubSegmentId(segment) {
  if (!segment) return '';
  const segments = state.dialogue?.segments || [];
  const index = Math.max(0, segments.indexOf(segment));
  return dubSegmentKey(segment, index);
}

async function ensureDubSegment(segment) {
  if (!segment?.turkishText) return null;
  const segmentId = getDubSegmentId(segment);
  if (!segmentId) return null;
  if (state.dubCache.has(segmentId)) return state.dubCache.get(segmentId);
  if (state.dubRequests.has(segmentId)) return state.dubRequests.get(segmentId);

  const request = fetch('/api/gemini-dub-segment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: segment.turkishText,
      gender: segment.gender,
      emotion: segment.emotion,
      speakerId: segment.speakerId || segmentId
    })
  }).then(async response => {
    const body = await response.json();
    if (!response.ok || !body?.available || !body?.audioBase64) {
      throw new Error(body?.error || body?.message || `HTTP ${response.status}`);
    }
    const source = `data:${body.mimeType || 'audio/wav'};base64,${body.audioBase64}`;
    state.dubCache.set(segmentId, source);
    return source;
  }).catch(error => {
    console.error('Dub segment failed:', segmentId, error);
    return null;
  }).finally(() => state.dubRequests.delete(segmentId));

  state.dubRequests.set(segmentId, request);
  return request;
}

function stopDubPlayback() {
  dubAudio.pause();
  state.activeDubSegmentId = null;
}

function resetDubState() {
  dubAudio.pause();
  dubAudio.removeAttribute('src');
  dubAudio.load();
  state.dubCache.clear();
  state.dubRequests.clear();
  state.dubSyncGeneration += 1;
  state.activeDubSegmentId = null;
}

function prefetchDubSegmentsAround(videoTime) {
  if (!state.dubbingEnabled) return;
  nextDialogueSegments(state.dialogue?.segments || [], videoTime, 3)
    .forEach(segment => void ensureDubSegment(segment));
}

function alignDubAudioToSegment(segment, videoTime) {
  const audioDuration = Number(dubAudio.duration);
  if (!Number.isFinite(audioDuration) || audioDuration <= 0) return;

  const segmentStart = Number(segment.startTime) || 0;
  const segmentEnd = Math.max(segmentStart + 0.05, Number(segment.endTime) || segmentStart + 0.05);
  const expected = mapVideoTimeToDubTime({
    videoTime,
    segmentStart,
    segmentEnd,
    audioDuration
  });

  if (Math.abs((Number(dubAudio.currentTime) || 0) - expected) > 0.22) {
    dubAudio.currentTime = expected;
  }

  dubAudio.playbackRate = fittedDubPlaybackRate({
    audioDuration,
    segmentDuration: segmentEnd - segmentStart,
    videoPlaybackRate: Number(els.video.playbackRate) || 1
  });
}

async function syncDubPlayback() {
  if (!state.dubbingEnabled) return stopDubPlayback();

  const generation = state.dubSyncGeneration;
  const videoTime = Math.max(0, Number(els.video.currentTime) || 0);
  const segment = getDubSegmentAt(videoTime);

  if (!segment) {
    stopDubPlayback();
    prefetchDubSegmentsAround(videoTime);
    return;
  }

  const segmentId = getDubSegmentId(segment);

  if (state.activeDubSegmentId === segmentId && dubAudio.src) {
    alignDubAudioToSegment(segment, videoTime);
    if (!els.video.paused && dubAudio.paused) {
      dubAudio.play().catch(() => {});
    }
    prefetchDubSegmentsAround(videoTime);
    return;
  }

  stopDubPlayback();
  const source = await ensureDubSegment(segment);
  if (!source || !state.dubbingEnabled || generation !== state.dubSyncGeneration) return;

  const currentTime = Math.max(0, Number(els.video.currentTime) || 0);
  const currentSegment = getDubSegmentAt(currentTime);
  if (!currentSegment || getDubSegmentId(currentSegment) !== segmentId) return;

  state.activeDubSegmentId = segmentId;
  dubAudio.src = source;
  dubAudio.load();

  const start = () => {
    if (
      !state.dubbingEnabled ||
      state.activeDubSegmentId !== segmentId ||
      generation !== state.dubSyncGeneration
    ) return;

    const now = Math.max(0, Number(els.video.currentTime) || 0);
    const stillCurrent = getDubSegmentAt(now);
    if (!stillCurrent || getDubSegmentId(stillCurrent) !== segmentId) return;

    alignDubAudioToSegment(stillCurrent, now);
    if (!els.video.paused) dubAudio.play().catch(() => {});
    prefetchDubSegmentsAround(now);
  };

  if (dubAudio.readyState >= 1) start();
  else dubAudio.addEventListener('loadedmetadata', start, { once: true });
}

els.video.addEventListener('timeupdate', () => void syncDubPlayback());
els.video.addEventListener('pause', () => dubAudio.pause());
els.video.addEventListener('seeking', () => {
  state.dubSyncGeneration += 1;
  dubAudio.pause();
  state.activeDubSegmentId = null;
});
els.video.addEventListener('seeked', () => {
  if (!state.dubbingEnabled) return;
  void syncDubPlayback();
  prefetchDubSegmentsAround(Number(els.video.currentTime) || 0);
});
els.video.addEventListener('play', () => {
  void syncDubPlayback();
  prefetchDubSegmentsAround(Number(els.video.currentTime) || 0);
});''',
    'replace block dubbing with dialogue-segment dubbing',
    flags=re.S
)

app = replace_once(
    app,
    "        // İlk dublaj bloğunu arka planda hazırla.\n        void ensureDubBlock(getDubBlockAt(0));",
    "        // İlk gerçek konuşma segmentlerini arka planda hazırla.\n        prefetchDubSegmentsAround(Number(els.video.currentTime) || 0);",
    'switch initial dub prefetch to segments'
)

old_chunk = '''      try {
        response = await fetch('/api/gemini-storyboard-analyze', {
          method: 'POST',
          body: form,
          signal: AbortSignal.timeout(200000)
        });

        body = await response.json();

        if (!response.ok || !body?.available) {
          failureBody = body || {
            available: false,
            reason: 'CHUNK_ANALYSIS_FAILED',
            message: `Bölüm ${chunkIndex + 1} analiz edilemedi.`
          };
          break;
        }

        chunkResults.push(body);
      if (body.protagonistProfile) {
        protagonistProfile = String(body.protagonistProfile).trim();
      }
      } catch (error) {
        failureBody = {
          available: false,
          reason: 'NETWORK_ERROR',
          message: `Bölüm ${chunkIndex + 1} sırasında bağlantı hatası oluştu.`,
          error: error?.message || String(error)
        };
        break;
      }
'''

new_chunk = '''      let chunkSucceeded = false;
      failureBody = null;

      for (let attempt = 1; attempt <= 3 && !chunkSucceeded; attempt += 1) {
        els.analysisOutput.textContent =
          `${chunkStart.toFixed(1)}–${chunkEnd.toFixed(1)} saniye ayrıntılı inceleniyor...\\n` +
          `Deneme ${attempt}/3 · tamamlanan ${chunkResults.length}/${chunkCount}`;

        try {
          response = await fetch('/api/gemini-storyboard-analyze', {
            method: 'POST',
            body: form,
            signal: AbortSignal.timeout(240000)
          });

          body = await response.json();

          if (!response.ok || !body?.available) {
            failureBody = body || {
              available: false,
              reason: 'CHUNK_ANALYSIS_FAILED',
              message: `Bölüm ${chunkIndex + 1} analiz edilemedi.`
            };
          } else {
            chunkResults.push(body);
            if (body.protagonistProfile) {
              protagonistProfile = String(body.protagonistProfile).trim();
            }
            chunkSucceeded = true;
            failureBody = null;
            break;
          }
        } catch (error) {
          failureBody = {
            available: false,
            reason: 'NETWORK_ERROR',
            message: `Bölüm ${chunkIndex + 1} sırasında bağlantı hatası oluştu.`,
            error: error?.message || String(error)
          };
        }

        if (attempt < 3) {
          await new Promise(resolve => setTimeout(resolve, attempt * 1800));
        }
      }

      if (!chunkSucceeded) break;
'''
app = replace_once(app, old_chunk, new_chunk, 'retry failed storyboard chunks')

app = sub_once(
    app,
    r"    if \(failureBody && !chunkResults\.length\) \{.*?\n    \}\n\n  if \(\n    body\?\.available &&",
    '''    const completeChunkAnalysis = isCompleteChunkAnalysis({
      completedChunkCount: chunkResults.length,
      expectedChunkCount: chunkCount,
      failed: Boolean(failureBody)
    });

    if (!completeChunkAnalysis) {
      body = {
        available: false,
        reason: 'INCOMPLETE_CHUNK_ANALYSIS',
        message:
          `Analiz eksik kaldı: ${chunkResults.length}/${chunkCount} bölüm tamamlandı. ` +
          `Eksik video hiçbir zaman hazır oyun olarak açılmayacak.`,
        completedChunkCount: chunkResults.length,
        expectedChunkCount: chunkCount,
        failedChunk: Math.min(chunkCount, chunkResults.length + 1),
        failure: failureBody
      };
    } else {
      const mergedActions = chunkResults
        .flatMap(result =>
          Array.isArray(result.actions) ? result.actions : []
        )
        .sort((a, b) =>
          Number(a.startTime) - Number(b.startTime)
        )
        .map((action, index) => ({
          ...action,
          actionId: `tl-${String(index + 1).padStart(3, '0')}`,
          sceneId: action.sceneId ||
            `scene-${String(index + 1).padStart(3, '0')}`
        }));

      const prompts = chunkResults
        .map(result => String(result.videoPrompt || '').trim())
        .filter(Boolean);

      const firstResult = chunkResults[0] || {};

      body = {
        available: true,
        videoDuration: storyboard.duration,
        introEndTime: Number(firstResult.introEndTime || 0),
        playStartTime: Number(
          firstResult.playStartTime ??
          firstResult.introEndTime ??
          0
        ),
        videoPrompt: prompts.join('\\n\\n'),
        actions: mergedActions,
        warnings: chunkResults.flatMap(result =>
          Array.isArray(result.warnings) ? result.warnings : []
        ),
        analysisMode: 'MULTI_PASS_DEEP',
        chunkCount: chunkResults.length,
        expectedChunkCount: chunkCount
      };
    }

  if (
    body?.available &&''',
    'reject partial chunk analysis instead of silently merging it',
    flags=re.S
)

app = replace_once(
    app,
    "  const normalized = normalizeAnalysis(body);\n  if (!normalized.actions.length) {",
    "  if (!body?.available) {\n    els.analysisState.textContent = body?.reason || 'ANALYSIS_INCOMPLETE';\n    els.analysisTitle.textContent = 'Video analizi eksik kaldı';\n    els.analysisOutput.textContent = body?.message || 'Tüm video bölümleri doğrulanmadan oyun başlatılmadı.';\n    setGameState('ERROR');\n    renderDebug({ lastAnalyzeBody: body });\n    return;\n  }\n\n  const normalized = normalizeAnalysis(body);\n  if (!normalized.actions.length) {",
    'surface incomplete analysis before normalization'
)

app = replace_once(
    app,
    "    `${Number(body.chunkCount || chunkCount)} analiz bölümü başarıyla birleştirildi.`,",
    "    `${Number(body.chunkCount || 0)}/${Number(body.expectedChunkCount || chunkCount)} analiz bölümü başarıyla birleştirildi.`,",
    'show actual completed chunk count'
)

path.write_text(app)
print('Applied full-analysis and segment-dub fix.')
