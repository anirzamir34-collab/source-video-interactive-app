// Storyboard analysis prompt for an adult interactive-video game.
// Each rule is stated once, grouped by topic. The previous long prompt is in
// analysis-prompt-legacy.js and can be restored with ANALYSIS_PROMPT=legacy.
export const ANALYSIS_PROMPT_VERSION = 'compact-v1';

const OUTPUT_SHAPE = `{
  "available": true,
  "videoDuration": number,
  "introEndTime": number,
  "playStartTime": number,
  "protagonistProfile": "stable visible identity description of MAIN_MALE",
  "videoPrompt": "concise chronological Turkish scenario",
  "actions": [
    {
      "actionId": "tl-001",
      "sceneId": "scene-001",
      "locationId": "stable-visible-location-id-or-empty",
      "actionLevel": "main|bonus",
      "actionType": "dialogue|story|scene_transition|position|tempo_change|kiss|touch|clothing|body_transition|partner_transition|camera_transition|outcome|aftermath|other",
      "choiceSurface": "story|approach|panel",
      "choiceSurfaceEvidence": "brief direct source evidence for this category",
      "choiceSurfaceConfidence": 0.0,
      "adultScene": false,
      "adultSceneId": "",
      "adultSceneStartTime": 0,
      "adultSceneEndTime": 0,
      "postSceneTime": 0,
      "positionId": "",
      "positionOccurrenceId": "",
      "receiverBodyOrientation": "on_top_facing|on_top_away|face_down_flat|on_back|side_lying|hands_knees|bent_over|standing|seated|unclear",
      "receiverSupport": "straddling|torso_flat|back_flat|hands_knees|side|seated|standing|unclear",
      "positionConfigurationConfidence": 0.0,
      "positionEvidence": "direct visible body-configuration evidence or empty string",
      "groupScene": false,
      "adultParticipantCount": 2,
      "participantTrackIds": [],
      "partnerTrackId": "",
      "partnerLabel": "",
      "involvedCharacterIds": [],
      "primaryCharacterId": "",
      "subjectTrackId": "",
      "primaryCharacterLabel": "",
      "partnerEvidence": "",
      "partnerSwitch": false,
      "previousPartnerTrackId": "",
      "activityType": "oral|manual|vaginal|anal|other",
      "activityTypeConfidence": 0.0,
      "activityEvidence": "brief directly visible evidence or empty string",
      "positionLabel": "",
      "positionStartTime": 0,
      "positionEndTime": 0,
      "loopStartTime": 0,
      "loopEndTime": 0,
      "verifiedSubsequences": [{ "startTime": 0, "endTime": 0, "sourceVerified": true, "movementTempo": "slow|moderate|fast", "movementType": "brief observed motion" }],
      "maleProgressRate": 1,
      "femaleProgressRate": 1,
      "outcomeType": "none|climax|aftermath",
      "outcomeLabel": "",
      "outcomeStartTime": 0,
      "outcomeEndTime": 0,
      "outcomeUnlockProgress": 82,
      "cameraMode": "third_person|male_pov|mixed|uncertain",
      "label": "short Turkish imperative",
      "narrativeChoiceLabel": "",
      "narrativeReason": "",
      "sceneTitle": "",
      "sceneGoal": "",
      "relationshipContext": "",
      "storyEvidenceLevel": "fact|inference|unknown",
      "storyConfidence": 0.0,
      "storyEvidence": "",
      "startTime": number,
      "endTime": number,
      "choiceKey": "stable-semantic-key",
      "movementType": "string",
      "movementVariant": "string",
      "movementTempo": "still|slow|moderate|fast|changing|unclear",
      "audioIntensity": "none|low|moderate|high|unclear",
      "nonSpeechAudio": "none|breathing|moan|laughter|crying|vocal_reaction|mixed|unclear",
      "gazeIntensity": "none|brief|sustained|mutual|unclear",
      "observedAffect": "neutral|relaxed|tense|happy|sad|fearful|excited|distressed|unclear",
      "bodyResponse": "relaxed|tense|recoil|rhythmic|still|changing|unclear",
      "sensoryEvidence": "brief directly observed audio/visual cues",
      "sensoryConfidence": 0.0,
      "bodyPart": "string",
      "direction": "string",
      "posture": "string",
      "contactPoint": "string",
      "interaction": "string",
      "sourceVerified": true,
      "confidence": number
    }
  ],
  "storyContext": {
    "synopsisTr": "",
    "currentSceneTitle": "",
    "currentSceneGoal": "",
    "setting": "",
    "emotionalTone": "",
    "characters": [],
    "relationships": [],
    "facts": [],
    "inferences": [],
    "unknowns": []
  },
  "warnings": []
}`;

export function buildAnalysisPrompt({
  duration, chunkIndex, chunkCount, chunkStart, chunkEnd, timestamps, motionProfile,
  sceneBoundaries, reviewInstructions = '', conditionalRelationshipInstructions = '', qualityMode,
  dialogueContext, dialogueSpeakerContext, sensoryAudioContext, storyContextMemory,
  protagonistProfile, protagonistHint, sourceKind = 'frames'
}) {
  const sourceLine = sourceKind === 'video'
    ? `You receive the source video itself (with its audio) for this chunk, from ${chunkStart} to ${chunkEnd} seconds. Report every time as absolute source-video seconds inside that range, never as seconds from the start of the clip. Use the real motion and sound for tempo, intensity and boundaries.`
    : 'You receive chronological contact-sheet images sampled from one local video; each tile shows its source timestamp.';
  return `
SOURCE VIDEO IS THE SINGLE SOURCE OF TRUTH.

TASK
This is an interactive adult video game for adults. ${sourceLine} Turn what is actually visible (plus time-aligned dialogue) into chronological, playable choices for the male protagonist MAIN_MALE. Analyze only the chunk interval given in CHUNK INPUT, deeply, instead of summarizing the whole video.

1. EVIDENCE
- Use only directly visible frames and time-aligned dialogue/audio. Never invent people, actions, dialogue, objects, contact, positions, movement, consent, intensity or outcomes.
- For every event separate: (a) whether it happened, (b) its source interval, (c) who is visibly involved, (d) optional specific details. When (d) is uncertain, keep (a)-(c) with a neutral accurate label, empty optional fields and a warning; omit an action only when its event or interval itself is unsupported.
- Precise claims (a position, a contact point, a penetration route, a movement loop) need consistent support at the interval's start, midpoint and end. If a hand or contact point is occluded, describe only what is visible; never guess a body part from posture, earlier labels or category metadata.
- A camera/viewpoint change, cut, close-up, crop or partial occlusion alone never changes an action, position or orientation. A missing frame is not proof that a scene is absent.
- When frames conflict about a specific classification, drop that classification, keep the visible event neutrally and add a warning. Report an analysis gap only for an interval that could not be analyzed at all.
- Dialogue never overrides contradictory visual evidence. Audio alone never proves pain, pleasure, consent, climax, a relationship or a feeling.

2. EVENTS, TIMING AND CHUNKS
- First list every distinct observable event in time order (story events, spoken decisions, opening interactions, sustained adult actions, visible changes inside them, transitions, aftermath), then assign each its choiceSurface and actionLevel.
- A new action starts only at an observable change: movement, tempo, direction, posture, body orientation, contact point, interaction, cast, location, speaker or scene. Continuous unchanging footage is one action regardless of length. Never split at equal time steps, never duplicate an action and never add filler to reach a count.
- MAIN = a major scene, location, position, body-arrangement or interaction change. BONUS = a meaningful visible change inside the same scene (pace, pause, kiss, touch, hand placement, posture, clothing, camera). BONUS actions keep the sceneId of their MAIN action. Actions in one continuous physical location share a locationId (empty when unverifiable).
- Actions are chronological, forward-moving and non-overlapping; consecutive actions may touch. Each has its own playable startTime < endTime, in absolute source seconds within 0 and the video duration and inside this chunk.
- Ordinary story choices: find the exact onset and end of each distinct event. End a choice before the next event's onset; one real event must not appear both as the tail of one clip and as the next choice. Two story choices share a startTime only when they are genuine alternatives at the same decision instant. When a boundary cannot be resolved, keep one neutral observation instead of two invented ones.
- Scene boundaries and the visual-change profile in CHUNK INPUT are navigation hints, not proof; prefer a boundary only when adjacent frames confirm the change.
- INTRO: only the contiguous non-story material before the first verified narrative event (logos, title cards, ads, previews) is intro. Do not classify character introductions or genuine dialogue as advertisements merely because they occur early. introEndTime is the first verified narrative frame. If no distinct opening non-story material is demonstrated, report 0. Later titles are scene transitions. playStartTime must equal introEndTime and no action may begin before it. For chunks after the first one, introEndTime and playStartTime must equal chunkStart.
- OUTRO: closing material after the last narrative event (credits, end cards, logos, previews of other videos, subscribe screens) is not story. Return it as one story action with actionType scene_transition whose label says what it is (e.g. Kapanış ekranı, Jenerik, Fragman), so the game can end before it. Never place a playable choice inside it.

3. CHOICE SURFACES (exactly one per action, with choiceSurfaceEvidence and choiceSurfaceConfidence)
- story: dialogue and ordinary narrative actions. Walking, sitting, watching, listening, speech, verbal commands, reactions and camera changes stay story unless the frames independently prove another category.
- approach: directly visible opening physical interaction before the first verified position — touching, caressing, kissing, hugging, removing or opening clothing — even when dialogue accompanies it.
- panel: a sustained, separately verifiable sexual interaction with a usable clip (positions and their internal movements). Oral and manual sexual activity are position families (positionId oral/manual); the app itself routes those that precede the first penetrative position into the approach panel.
- Never merge actions from different surfaces into one option or stretch timestamps across a surface boundary. A conversation mentioning an act is not evidence that it happened. A scene envelope does not change the surface of the conversation, pauses or camera changes inside it.

4. PEOPLE, PROTAGONIST AND VOICES
- Give every visible adult a stable neutral participantTrackId (MAIN_MALE, PARTNER_A, PARTNER_B, OTHER_MALE...; never invent others such as MALE_1, FEMALE_1, man-blue) reused across chunks from face, hair, body, clothing and scene continuity; never a real-world identity.
- MAIN_MALE: the locked profile in CHUNK INPUT, or the user's visual description when frames support it. With no description, MAIN_MALE is the adult male with the most screen presence and story agency across the video; a male point-of-view camera owner counts as MAIN_MALE. Once chosen, keep the same person for the whole video; never switch because another man is larger or more central in a frame. An opening chapter with only women does not prove there is no protagonist and does not justify inventing one.
- When a female partner acts on MAIN_MALE (massages him, undresses him, climbs on top, oral on him), the action still belongs to his scene: set subjectTrackId to her, partnerTrackId and involvedCharacterIds to include MAIN_MALE, and write the label as his choice (e.g. Masaj yapmasına izin ver, Üstüne çıkmasına izin ver).
- Every returned action belongs to MAIN_MALE or his POV camera. Other men are OTHER_MALE; never turn their actions into player choices. If identity is uncertain, keep the event as neutral story context with uncertain identity. Return a short stable protagonistProfile with persistent visible anchors.
- Dialogue: use a segment only when its timestamp overlaps the visible scene. Distinguish speaker, addressee and an off-screen person mentioned; hearing a name does not name the speaker. Match a speakerId to a participantTrackId only with time-aligned visible speaking evidence, never by gender, list order or head count; record speakerIds and voiceMatchEvidence on that character. When several speakerIds are each directly matched to the same character, list them all on that character; never merge them merely because two people are visible. Voice IDs are not visual character IDs.
- Explicit names and relationship statements in originalText may establish identity even without subtitles; keep the exact quotation and timestamp as evidence. A quote about someone off-screen must not be assigned to a visible person. If diarization merges two distinct speakers, mark the match ambiguous.
- For each recurring character return gender (male/female/uncertain), voiceTone and voiceEmotion only when supported; otherwise "uncertain" or empty.

5. STORY CONTEXT AND RELATIONSHIPS
- Understand the scene as a story (setting, purpose, tone, roles, goals, tension) and keep continuity across chunks, but PRIOR MEMORY NEVER OVERRIDES current source frames or current time-aligned dialogue.
- Knowledge has three levels: fact (directly visible or explicitly stated, with evidence and confidence), inference (strongly suggested, phrased as inference, with evidence/confidence), unknown. Never promote unknown to fact. Return facts[], inferences[] and unknowns[] as readable text, never nested objects.
- A relationship or background label becomes FACT only when the source explicitly establishes it; appearance, age differences, familiarity and setting are insufficient. Otherwise record the role as uncertain, without guessing.
- characters[]: id, participantTrackId, displayName, sourceRole, gender, voiceTone, voiceEmotion, speakerIds, voiceMatchEvidence, evidenceLevel, confidence, evidence. displayName is an explicitly spoken proper name (preserve it exactly) or a short Turkish visual label (Sarışın kadın, Bıyıklı adam), never a track id or a bare gender word (male, female); never manufacture possessive identities. If a later chunk reveals a name, update the same entry. Keep a short distinctive visual description for unnamed people.
- Every relationship entry must contain from, to, relation, evidenceLevel, confidence and evidence. Relationship direction is explicit: from identifies the reference person, to identifies the other person, and relation describes TO relative to FROM. Add inverse edges only when evidence establishes both.
- Never infer age, kinship or another sensitive relationship from appearance. If dialogue explicitly establishes a sensitive family relationship, retain it only as neutral factual story context; do not turn that relationship label into sexualized choice wording, a reward, or invented motivation.
- For ordinary non-intimate story actions, relationshipContext may state a verified relationship for the exact two character IDs. For adult/intimate actions, keep verified relationships in top-level storyContext only and leave relationshipContext empty. Exception: when original evidence proves the partner is MAIN_MALE's own wife, address her as karın in intimate labels; never infer a spouse bond and never use other kinship roles in intimate wording.
- Each action returns subjectTrackId (actor), primaryCharacterId (the exact addressee/partner, referencing a character id or participantTrackId), involvedCharacterIds (only people in this exact action) and primaryCharacterLabel. Apply identity rules equally to two-person and group scenes.
- Return top-level storyContext with synopsisTr, currentSceneTitle, currentSceneGoal, setting, emotionalTone, characters, relationships, facts, inferences, unknowns.

6. TURKISH LABELS (label, narrativeChoiceLabel, sceneTitle, sceneGoal, positionLabel, movementType, outcomeLabel)
- Natural, short Turkish; preserve proper names; translate only what the evidence supports.
- label is a short imperative for MAIN_MALE describing the real playable action of that exact interval; narrativeChoiceLabel is the story-aware version of the same action. Neither may promise anything absent from that interval.
- Name characters the way the story does: verified displayName, else the non-family story role (komşu, patron, dedektif, ev sahibi...), else a stable visual description (sarışın kadın), and Partner A/B only as a last resort. Labels never contain track ids (PARTNER_A, MAIN_MALE...). Do not fall back to generic kadın, erkek, biri or partner when a stable identity exists. Approach and panel labels continue the same story (names, place, situation) so they read as its next beat.
- Never attach a label seen in one part of the video to an earlier or later segment, and never replace precise position controls with fictional dialogue or outcomes.
- Uncertain context gets neutral wording such as "Onunla konuşmaya devam et". Each action also returns narrativeReason, sceneTitle, sceneGoal, storyEvidenceLevel, storyConfidence and storyEvidence.

7. ADULT SCENES (consensual encounters between clearly adult people)
- Write adult labels in explicit, direct and natural Turkish, naming the exact verified sexual action without censorship or euphemism. Do not soften verified acts into vague labels such as devam et, yakınlaş, pozisyonu değiştir or hareketi sürdür. Name the visible actor and the particular observed movement or contact; a bare position name or "ritmik hareket" is incomplete when a more specific act is visible.
- If adulthood or the act itself is uncertain, keep the description neutral and limited to clearly observable movement.
- Envelope: mark adultScene true only inside a real scene. One continuous encounter (foreplay, oral/manual, every position, climax, aftermath) keeps one adultSceneId; start a new one only after a clear narrative, location, participant or substantial time break. adultSceneStartTime/EndTime cover the real scene; postSceneTime is its first real continuation.
- Groups: set groupScene true and adultParticipantCount only when three or more clearly adult participants are visibly present; never infer off-screen people. participantTrackIds lists only adults in this exact interval; partnerTrackId is the one adult paired with MAIN_MALE; partnerLabel follows the naming order in section 6. Simultaneous multiple partners in one interval: partnerTrackId MULTI_PARTNER and partnerLabel Birden fazla partner.
- Partner changes: a new partner means a new positionOccurrenceId even for the same position. Set partnerSwitch and emit actionType partner_transition (label like Partner B'ye geç) only when frames show MAIN_MALE ending with previousPartnerTrackId and starting with a different partnerTrackId and the handoff has a playable interval; never before the first verified position, never as foreplay. A hard cut to a new partner gets no transition clip.

8. POSITIONS
- A position is a stable adult-act body configuration sustained over time (actionType position). Undressing, dressing, walking, preparation, conversation, pauses, camera changes and generic standing/sitting are never positions and get no positionId.
- Canonical positionId values only: oral, manual, reverse-cowgirl, seated-facing, prone-bone, legs-up, missionary, cowgirl, spoon, reverse-spoon, standing-rear, rear, seated, standing. Never create custom ids. Choose by the body arrangement relative to MAIN_MALE, never by which side faces the camera:
  oral: a mouth on genitals, whatever the body arrangement. Never name oral contact cowgirl, reverse-cowgirl or another penetrative position; a penetrative name requires visible penetration in that exact interval.
  manual: hand stimulation of genitals.
  cowgirl: partner on top straddling MAIN_MALE, facing him (on_top_facing + straddling), including astride on his lap.
  reverse-cowgirl: same, but torso/head facing away from him at start, midpoint and end (on_top_away + straddling). If on top but facing cannot be verified, omit the classification and warn.
  missionary: partner on their back below, MAIN_MALE above and front-facing.
  rear (doggy-style): partner on hands and knees with MAIN_MALE behind.
  standing-rear: partner bent over while standing, MAIN_MALE behind, standing lower-body support visible.
  prone-bone: partner lying face-down and flat with low hips, MAIN_MALE behind. Never collapse it into rear, missionary or spoon; it is mutually exclusive with cowgirl.
  spoon / reverse-spoon: side-lying, in the respective orientation.
  seated-facing: seated/lap position facing each other without straddling on top; seated: other clearly seated configurations.
  legs-up: legs visibly raised in a sustained configuration, never for a brief transition.
  standing: other standing configurations.
- A furniture or direction word is never position evidence ("koltuğun arkasına", "arkaya yönlendir", "ağzından öp"). Leaning on furniture is not lying flat; do not infer support from a cropped torso.
- For every position return receiverBodyOrientation, receiverSupport, positionConfigurationConfidence and positionEvidence from the visible arrangement at start, midpoint and end; never copy them from positionId. positionId, positionLabel and label must agree, otherwise omit the position.
- Each uninterrupted occurrence of a position has its own positionOccurrenceId, positionStartTime and positionEndTime and an exact Turkish positionLabel. When the configuration changes, end the occurrence before the change and start the next at its first clearly verified frame; split at the visible transition, which belongs to neither position. The same position returning later is a new occurrence; never bridge separate appearances. Two labels for the same configuration reuse one positionId.
- Penetration route: positionId never determines it; every position can be vaginal or anal. Set activityType vaginal or anal only when the route is directly visible and consistent at start, midpoint and end; otherwise other (oral/manual when that is what is visible). activityTypeConfidence rates the route only; reach 0.90 only with clear consistent evidence. activityEvidence briefly states the visible evidence (empty for other; never dialogue alone). The label may say vajinal or anal only with activityTypeConfidence >= 0.90 and activityEvidence. Never default an ambiguous penetrative candidate to vaginal. A route change within the same position starts a new action and occurrence.

9. MOVEMENTS, TEMPO AND LOOPS
- Inside each position return every meaningful visible change (tempo, depth, grip or hand placement, body angle, pause and restart, intensity, interaction) as its own action of the same positionId, each with a concise movementType and Turkish label naming the actor and what visibly changes. A sustained position longer than about 25 seconds normally contains several such moments (typically 8–20 seconds each); never repeat one label across the whole span and never invent a change. Do not split tiny repetitions or merge genuinely different changes.
- Each panel label names what is visibly done in that exact interval (e.g. bacaklarını kaldır, onu ters çevir, kucağına al). When a visible body change happens (legs raised, turned over, moved on top), start a new segment at that change so the label matches its first frames. Never use an intensifier such as daha derin or daha hızlı unless that change itself is the dominant visible difference.
- Movement labels never contain timestamps, durations, sequence numbers, breathing, moaning, gaze, emotion, appearance or confidence, and never penetration-route words, position-change words or another position's name. Kissing, caressing, breast touching or clothing adjustment during a position is a separate action, not a movement of that position.
- movementTempo comes from visible cadence. Do not default to moderate: compare segments within the same video and mark the visibly calmest ones slow and the visibly most rapid or vigorous ones fast (fast only when consistently fast across the whole interval); unclear when it cannot be verified; split a changing cadence at its visible boundaries. Words such as sert, derin or güçlü appear only when that quality is visible throughout the segment.
- audioIntensity (low/moderate/high) from time-aligned audible intensity; femaleProgressRate and maleProgressRate (0.25–2.5) from visible motion intensity: calm 0.5–0.8, ordinary 1, vigorous 1.5–2.5. Do not fill every action with 1.
- Fuse only time-aligned observable cues into nonSpeechAudio, gazeIntensity, observedAffect and bodyResponse; observedAffect stays unclear unless several consistent cues support it.
- loopStartTime/loopEndTime: a naturally repeatable real interval fully inside the action and its position range. Every position and selectable loop lasts at least 5.0 seconds, verified at start, midpoint and end; never a frozen frame, transition, cut or camera change.
- verifiedSubsequences: for a long continuous action, list 5+ second segments only where frames establish natural boundaries (same configuration, participants and camera continuity); otherwise []. Never divide at equal steps.
- Outcomes: a visible climax/final segment is actionType outcome, outcomeType climax, with exact outcomeStartTime/outcomeEndTime and a short outcomeLabel; a distinct post-final continuation is actionType aftermath, outcomeType aftermath. Neither gets a positionId or overlaps a movement loop. outcomeUnlockProgress is a pacing hint (default 82). With no verified outcome keep outcomeType none.

10. CAMERA
- cameraMode: third_person (MAIN_MALE externally visible), male_pov (viewpoint reliably his; use visible hands, arms, body position and continuity even when his body is absent), mixed (visible switch), uncertain.

Return ONLY valid JSON with this exact shape:
${OUTPUT_SHAPE}

CHUNK INPUT (only this part changes between requests; every rule above applies to it):
Video duration: ${duration} seconds
Current analysis chunk: ${chunkIndex + 1} of ${chunkCount}
Analyze ONLY the interval ${chunkStart} to ${chunkEnd} seconds.
Timestamp metadata for this chunk: ${timestamps}
Local visual-change profile for this chunk: ${motionProfile}
Detected visual scene boundaries for this chunk: ${sceneBoundaries}
${reviewInstructions}
${conditionalRelationshipInstructions}
Quality mode: ${qualityMode}
Time-aligned dialogue segments:
${dialogueContext}
Stable audio speaker registry (voice IDs are NOT visual character IDs):
${dialogueSpeakerContext}
Time-aligned non-speech audio observations:
${sensoryAudioContext}
Prior verified story memory from earlier chunks:
${storyContextMemory}
PROTAGONIST IDENTITY LOCK — current locked profile:
${protagonistProfile || "NOT_LOCKED. The protagonist may first appear in a later chapter. Do not promote an unobserved person to MAIN_MALE; retain neutral character facts and allow later chapters to identify him."}
Optional user-provided *visual description* (not identity proof): ${JSON.stringify(protagonistHint)}
`;
}
