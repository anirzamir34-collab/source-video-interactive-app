from pathlib import Path
p=Path('server.js')
s=p.read_text()
marker="const wait = ms => new Promise(resolve => setTimeout(resolve, ms));\n"
helper=r'''

function parseGeminiOffsetSeconds(value) {
  const match = String(value || '').trim().match(/^([0-9]+(?:\.[0-9]+)?)s$/i);
  return match ? Number(match[1]) : 0;
}

function extractTranscribeWordAnnotations(interaction) {
  const words = [];
  for (const step of interaction?.steps ?? []) {
    for (const content of step?.content ?? []) {
      for (const annotation of content?.annotations ?? []) {
        if (annotation?.type !== 'word_info') continue;
        const text = String(annotation.text || '').trim();
        if (!text) continue;
        words.push({ text, speakerId: String(annotation.speaker || 'spk_unknown'), startTime: parseGeminiOffsetSeconds(annotation.start_offset), endTime: parseGeminiOffsetSeconds(annotation.end_offset) });
      }
    }
  }
  return words.sort((a, b) => a.startTime - b.startTime);
}

function groupTranscribeWords(words) {
  const groups = [];
  for (const word of words) {
    const last = groups.at(-1);
    const speakerChanged = last && last.speakerId !== word.speakerId;
    const gap = last ? Math.max(0, word.startTime - last.endTime) : 0;
    const tooLong = last ? word.endTime - last.startTime >= 7 : false;
    if (!last || speakerChanged || gap > 1.15 || tooLong) {
      groups.push({ speakerId: word.speakerId, startTime: word.startTime, endTime: word.endTime, words: [word.text] });
    } else {
      last.endTime = Math.max(last.endTime, word.endTime);
      last.words.push(word.text);
    }
  }
  return groups.map((group, index) => ({
    segmentId: `asr-${String(index + 1).padStart(3, '0')}`,
    speakerId: group.speakerId,
    startTime: group.startTime,
    endTime: group.endTime,
    originalText: group.words.join(' ').replace(/\s+([,.!?;:])/g, '$1').trim()
  }));
}

async function transcribeDialogueGemini35(ai, remoteFile) {
  const interaction = await ai.interactions.create({
    model: process.env.GEMINI_TRANSCRIBE_MODEL || 'gemini-3.5-transcribe',
    input: [{ type: 'audio', uri: remoteFile.uri, mime_type: remoteFile.mimeType }],
    generation_config: {
      transcription_config: {
        language_codes: [],
        mode: { type: 'verbatim', diarization_mode: 'speaker', timestamp_granularities: ['word'] }
      }
    }
  });
  const words = extractTranscribeWordAnnotations(interaction);
  return { transcriptText: String(interaction?.output_text || '').trim(), words, segments: groupTranscribeWords(words) };
}
'''
if 'async function transcribeDialogueGemini35' not in s:
    if marker not in s: raise SystemExit('wait marker not found')
    s=s.replace(marker, marker+helper, 1)
old="""      const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: [{
          role: 'user',
          parts: [
            {
              fileData: {
                fileUri: remoteFile.uri,
                mimeType: remoteFile.mimeType || req.file.mimetype
              }
            },
            { text: prompt }
          ]
        }],
        config: {
          responseMimeType: 'application/json',
          temperature: 0.1
        }
      });

      const raw = String(response.text || '').trim();
      const parsed = JSON.parse(
        raw.replace(/^```json\\s*/i, '').replace(/```\\s*$/i, '')
      );
"""
new="""      const audioMime = String(remoteFile.mimeType || req.file.mimetype || '').toLowerCase();
      let asr = null;
      if (audioMime.startsWith('audio/')) {
        asr = await transcribeDialogueGemini35(ai, remoteFile);
      }

      const transcriptGrounding = asr?.segments?.length
        ? `\\nGEMINI 3.5 TRANSCRIBE GROUND TRUTH:\\n${JSON.stringify(asr.segments)}\\n\\n- Preserve every supplied segmentId, speakerId, startTime and endTime exactly.\\n- originalText comes from the dedicated transcription model; do not paraphrase it.\\n- Translate originalText into natural Turkish and infer gender/emotion conservatively from the audio.\\n- Do not merge, split, reorder or retime these grounded segments.\\n`
        : '';

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
          temperature: 0.05
        }
      });

      const raw = String(response.text || '').trim();
      const parsed = JSON.parse(
        raw.replace(/^```json\\s*/i, '').replace(/```\\s*$/i, '')
      );

      if (asr?.segments?.length) {
        const enriched = new Map((Array.isArray(parsed.segments) ? parsed.segments : []).map(item => [String(item.segmentId || ''), item]));
        parsed.segments = asr.segments.map((grounded, index) => {
          const item = enriched.get(grounded.segmentId) || parsed.segments?.[index] || {};
          return { ...item, segmentId: grounded.segmentId, speakerId: grounded.speakerId, startTime: grounded.startTime, endTime: grounded.endTime, originalText: grounded.originalText, turkishText: String(item.turkishText || grounded.originalText).trim() };
        });
        parsed.transcriptionEngine = process.env.GEMINI_TRANSCRIBE_MODEL || 'gemini-3.5-transcribe';
      }
"""
if old not in s: raise SystemExit('dialogue block not found')
s=s.replace(old,new,1)
anchor="""        sourceLanguage: String(parsed.sourceLanguage || 'unknown'),
        summaryTr: String(parsed.summaryTr || ''),
        speakers: Array.isArray(parsed.speakers) ? parsed.speakers : [],
        segments,
        warnings: Array.isArray(parsed.warnings) ? parsed.warnings : []
      });"""
replacement="""        sourceLanguage: String(parsed.sourceLanguage || 'unknown'),
        summaryTr: String(parsed.summaryTr || ''),
        speakers: Array.isArray(parsed.speakers) ? parsed.speakers : [],
        segments,
        warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
        transcriptionEngine: String(parsed.transcriptionEngine || 'gemini-3.8-flash-fallback'),
        translationEngine: process.env.GEMINI_DIALOGUE_MODEL || 'gemini-3.8-flash',
        dubbingEngine: process.env.GEMINI_TTS_MODEL || 'gemini-3.1-flash-tts-preview'
      });"""
if anchor not in s: raise SystemExit('dialogue return not found')
s=s.replace(anchor,replacement,1)
s=s.replace("model: 'gemini-3.1-flash-tts-preview',", "model: process.env.GEMINI_TTS_MODEL || 'gemini-3.1-flash-tts-preview',")
p.write_text(s)
