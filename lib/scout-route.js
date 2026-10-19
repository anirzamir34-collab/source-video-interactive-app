// Cheap timeline scout for long videos. One request looks at a few sparse
// contact sheets and labels each time range; it never produces choices.
import { parseModelJson } from '../public/model-json.js';

export const SCOUT_PROMPT_VERSION = 'scout-v1';
const KINDS = ['story', 'scene_change', 'approach', 'intimate', 'uncertain'];

export function scoutPrompt({ startTime, endTime, timestamps }) {
  return `You label the timeline of one interval of a video from sparse contact-sheet frames.
Each tile shows its source timestamp. Label every part of the interval ${startTime} to ${endTime} seconds with exactly one kind:
- story: conversation, walking, sitting, watching, ordinary activity, no physical intimacy.
- scene_change: a new location or a clearly new scene begins (label only the short range around the change).
- approach: non-sexual physical intimacy between participants: kissing, touching, caressing, hugging, undressing.
- intimate: sexual activity of any kind, including oral or manual activity.
- uncertain: the frames do not let you decide.
Rules: cover the whole interval without gaps or overlaps, in time order; use only the supplied timestamps as boundaries;
prefer uncertain over guessing; never describe the content.
Return JSON only: {"segments":[{"startTime":0,"endTime":0,"kind":"story"}]}
Frame timestamps: ${JSON.stringify(timestamps)}`;
}

export function sanitizeScoutSegments(value, { startTime, endTime }) {
  const rows = Array.isArray(value?.segments) ? value.segments : [];
  return rows.map(row => ({
    startTime: Math.max(startTime, Number(row?.startTime)),
    endTime: Math.min(endTime, Number(row?.endTime)),
    kind: KINDS.includes(row?.kind) ? row.kind : 'uncertain'
  })).filter(row => Number.isFinite(row.startTime) && Number.isFinite(row.endTime) && row.endTime > row.startTime)
    .sort((a, b) => a.startTime - b.startTime);
}

export function installScoutRoute(app, { upload, resolveApiKey, GoogleGenAI, model, safetySettings,
  emptyUsage, addUsage, failureReason }) {
  app.post('/api/gemini-scout', upload.array('storyboards', 8), async (req, res) => {
    const usage = emptyUsage();
    try {
      const apiKey = resolveApiKey(req);
      if (!apiKey) return res.status(503).json({ available: false, reason: 'GEMINI_NOT_CONFIGURED' });
      const files = Array.isArray(req.files) ? req.files : [];
      if (!files.length) return res.status(400).json({ available: false, reason: 'STORYBOARD_REQUIRED' });
      const startTime = Math.max(0, Number(req.body?.startTime || 0));
      const endTime = Math.max(startTime, Number(req.body?.endTime || 0));
      let timestamps = [];
      try { timestamps = JSON.parse(String(req.body?.timestamps || '[]')).map(Number).filter(Number.isFinite); } catch {}
      const ai = new GoogleGenAI({ apiKey });
      const startedAt = Date.now();
      const response = await ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [
          { text: scoutPrompt({ startTime, endTime, timestamps }) },
          ...files.map(file => ({ inlineData: { mimeType: file.mimetype || 'image/jpeg', data: file.buffer.toString('base64') } }))
        ] }],
        config: {
          responseMimeType: 'application/json', temperature: 0, maxOutputTokens: 2048,
          thinkingConfig: { thinkingLevel: 'low' }, mediaResolution: 'MEDIA_RESOLUTION_LOW',
          safetySettings, httpOptions: { timeout: 60000, retryOptions: { attempts: 1 } }
        }
      });
      addUsage(usage, response?.usageMetadata);
      const segments = sanitizeScoutSegments(parseModelJson(response?.text), { startTime, endTime });
      console.info('[gemini-request-usage]', JSON.stringify({ stage: 'scout', model, durationMs: Date.now() - startedAt,
        sheetCount: files.length, segmentCount: segments.length, ...usage }));
      return res.json({ available: true, version: SCOUT_PROMPT_VERSION, startTime, endTime, segments, aiUsage: usage });
    } catch (error) {
      const reason = failureReason(error);
      console.warn('[gemini-scout-failure]', JSON.stringify({ reason }));
      // A failed scout range is analysed in detail by the caller, never skipped.
      return res.status(200).json({ available: false, reason, aiUsage: usage });
    }
  });
}
