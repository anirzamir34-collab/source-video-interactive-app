// Storyboard analysis prompt for an adult interactive-video game.
// Each rule is stated once, grouped by topic. The previous long prompt is in
// analysis-prompt-legacy.js and can be restored with ANALYSIS_PROMPT=legacy.
export const ANALYSIS_PROMPT_VERSION = 'compact-v2';

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
      "mainMalePosture": "lying_back|seated|kneeling|standing|on_top|behind|unclear",
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
      "verifiedSubsequences": [{ "startTime": 0, "endTime": 0, "sourceVerified": true, "movementTempo": "slow|moderate|fast", "movementChange": "none|faster|slower|harder|deeper", "movementType": "brief observed motion", "label": "", "audioIntensity": "low|moderate|high|unclear" }],
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
      "movementTempo": "still|slow|moderate|fast|changing|unclear",
      "oralGiver": "partner|main_male|mutual|",
      "movementChange": "none|faster|slower|harder|deeper",
      "receiverLegs": "raised_on_shoulders|raised|spread|together|unclear",
      "audioIntensity": "none|low|moderate|high|unclear",
      "nonSpeechAudio": "none|breathing|moan|laughter|crying|vocal_reaction|mixed|unclear",
      "gazeIntensity": "none|brief|sustained|mutual|unclear",
      "observedAffect": "neutral|relaxed|tense|happy|sad|fearful|excited|distressed|unclear",
      "bodyResponse": "relaxed|tense|recoil|rhythmic|still|changing|unclear",
      "sensoryEvidence": "brief directly observed audio/visual cues",
      "sensoryConfidence": 0.0,
      "sourceVerified": true,
      "confidence": number
    }
  ],
  "rewardMoments": [{ "rewardType": "her_climax|highlight", "startTime": 0, "endTime": 0, "label": "", "partnerTrackId": "", "evidence": "", "sourceVerified": true }],
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
  protagonistProfile, protagonistHint, castNote = '', sourceKind = 'frames'
}) {
  const sourceLine = sourceKind === 'video'
    ? `You receive the source video itself (with its audio) for this chunk, from ${chunkStart} to ${chunkEnd} seconds. Report every time as absolute source-video seconds inside that range, never as seconds from the start of the clip. Use the real motion and sound for tempo, intensity and boundaries.`
    : 'You receive chronological contact-sheet images sampled from one local video; each tile shows its source timestamp.';
  return `
SOURCE VIDEO IS THE SINGLE SOURCE OF TRUTH.

TASK
This is an interactive video game for adults. ${sourceLine} Turn what is actually visible (plus time-aligned dialogue) into chronological, playable choices for the player character MAIN_MALE. Analyze only the chunk interval in CHUNK INPUT, in depth.

TERMS (used the same way everywhere below)
- action: one continuous, observable thing in the video, from its first to its last frame. Continuous unchanging footage is one action regardless of length; a new action starts only at a visible change.
- verifiedSubsequences: playback parts INSIDE one long action (10-20 s each), so a long action can be played step by step. They are not new actions and never change the action's own start, end or label.
- position: a sustained sexual body arrangement (section 6). A movement is an action inside a position.
- ageGroup: only a rough voice-casting hint for dubbing (young adult, adult, mature, senior) from the visible look. It is never a stated age, never a story fact and never used in labels.

1. EVIDENCE
- Grounding: every action, label, name, position, route, partner, tempo change, reward and story fact must be visible (or, for speech, audible and time-aligned) inside the exact interval it is attached to. Nothing is imagined, completed from genre expectations or borrowed from another part of the video. Fewer accurate actions are better than more invented ones; an empty optional field is better than a guess.
- A precise claim (position, contact, penetration route, movement loop) needs consistent support at the interval's start, midpoint and end. If something is occluded, describe only what is visible.
- A camera change, cut, close-up, crop or partial occlusion alone never changes an action, position or orientation. A missing frame is not proof that something is absent.
- When frames conflict about a classification, keep the visible event with a neutral label, leave the classification empty and add a warning. Report an analysis gap only for an interval that could not be analyzed at all.
- Dialogue never overrides contradictory visuals. Sound alone never proves pain, pleasure, consent, climax, a relationship or a feeling.

2. TIMING
- List the observable events in time order, then classify each. A new action starts only at an observable change: movement, tempo, direction, posture, orientation, contact point, interaction, cast, location, speaker or scene. Never split at equal time steps, never duplicate, never add filler.
- MAIN = a major scene, location, position or interaction change. BONUS = a meaningful visible change inside the same scene (pace, pause, kiss, touch, hand placement, clothing); it keeps its MAIN action's sceneId. One continuous physical place shares a locationId (empty when unverifiable).
- Actions are chronological and non-overlapping (they may touch), with startTime < endTime in absolute source seconds inside this chunk. A story choice ends before the next event starts. Two story choices share a startTime only when they are real alternatives at the same instant.
- Scene boundaries and the visual-change profile are hints; use a boundary only when adjacent frames confirm it.
- INTRO: only the contiguous non-story material before the first verified narrative event (logos, title cards, ads, previews) is intro. Do not classify character introductions or genuine dialogue as advertisements merely because they occur early. If no distinct opening non-story material is demonstrated, report 0. playStartTime equals introEndTime. For later chunks both equal chunkStart.
- OUTRO: closing material (credits, end cards, logos, other videos' previews) is one story action with actionType scene_transition and a label saying what it is (Kapanış ekranı, Jenerik). No playable choice inside it.

3. CHOICE SURFACES (exactly one per action, with choiceSurfaceEvidence and choiceSurfaceConfidence)
- story: dialogue and ordinary actions (walking, sitting, talking, reacting, camera changes).
- approach: visible opening physical contact before the first position: touching, caressing, kissing, hugging, undressing.
- panel: a sustained sexual interaction with a usable clip (positions and their movements, including oral and manual).
- A conversation about an act is not evidence that it happened. Never stretch one action across two surfaces.

4. PEOPLE AND VOICES
- Every visible adult gets a stable participantTrackId reused across chunks: MAIN_MALE, PARTNER_A, PARTNER_B... for everyone MAIN_MALE is intimate with (any gender), OTHER_MALE / OTHER_FEMALE for people outside his interaction. Never invent other ids.
- MAIN_MALE is the locked profile, else the user's description when frames support it, else the man with the most screen presence and agency (a male POV camera counts). Keep the same person for the whole video. In a video without men he is the described person or the most active woman. Return a short protagonistProfile with persistent visible anchors.
- Every action belongs to MAIN_MALE's experience. When a partner acts on him (undresses him, climbs on top, gives oral), subjectTrackId is her, involvedCharacterIds include MAIN_MALE, and the label is his choice (Üstüne çıkmasına izin ver). Other men's actions are never player choices.
- Dialogue: use a line only when its time overlaps the scene. A speakerId is matched to a person only with time-aligned visible speaking evidence (record speakerIds and voiceMatchEvidence), never by gender or order. Several speakerIds may belong to one person; never merge two people into one speakerId unless the audio truly cannot tell them apart. A name heard in dialogue does not name the speaker; a quote about someone off-screen is not about a visible person.
- characters[]: id, participantTrackId, displayName, sourceRole, gender (male/female/uncertain), genderIdentity, ageGroup, voiceTone, voiceEmotion, speakerIds, voiceMatchEvidence, evidenceLevel, confidence, evidence. Put looks only in description.
- displayName: an explicitly spoken proper name (exactly as heard), else a plain Turkish age word (Genç kadın, Kadın, Olgun kadın, Yaşlı kadın / Genç adam, Adam, Olgun adam, Yaşlı adam), numbered in order of appearance when two share it (Genç kadın 2). Never a look (no Sarışın kadın, Örgülü kadın), never kız for an adult, never a track id. The same person keeps the same name in every chunk, label and summary; a name revealed later updates the same entry.
- genderIdentity: trans_woman, trans_man, nonbinary, femboy (a man presenting feminine; gender male), or empty. Set it only when the video establishes it (on-screen text, dialogue, or in a sexual scene a performer presenting as a woman or man whose body visibly shows otherwise) or when the viewer's cast note says so; never from a face, build or voice alone. A trans woman is a woman: gender female, she/her, displayName her name or Trans kadın. A trans performer can give or receive in any position.

5. STORY CONTEXT AND RELATIONSHIPS
- Understand the scene as a story (setting, purpose, tone, roles, goals) and keep continuity across chunks, but prior memory never overrides current frames or current dialogue.
- Knowledge levels: fact (directly visible or explicitly stated, with evidence), inference (strongly suggested, marked as such), unknown. Never promote unknown to fact. facts[], inferences[] and unknowns[] are plain text.
- A relationship or background label becomes FACT only when the source explicitly establishes it; appearance, age differences, familiarity and setting are insufficient.
- Every relationship entry must contain from, to, relation, evidenceLevel, confidence and evidence. Relationship direction is explicit: from identifies the reference person, to the other person, and relation describes TO relative to FROM.
- Never infer age, kinship or another sensitive relationship from appearance. If dialogue explicitly establishes a sensitive family relationship, retain it only as neutral factual story context; do not turn that relationship label into sexualized choice wording, a reward or a motive.
- For ordinary story actions relationshipContext may state a verified relationship of the exact two people. For adult/intimate actions, keep verified relationships in top-level storyContext only and leave relationshipContext empty. Only a proven wife of MAIN_MALE may be called karın in intimate labels.
- Each action returns subjectTrackId, primaryCharacterId, involvedCharacterIds (only people in this action) and primaryCharacterLabel.
- storyContext: synopsisTr, currentSceneTitle, currentSceneGoal, setting, emotionalTone, characters, relationships, facts, inferences, unknowns. synopsisTr and videoPrompt describe only THIS chunk, in order, in 2-4 plain sentences, with every person called by their displayName. The app joins chunks into one story.

6. TURKISH LABELS
- label is a short Turkish imperative for MAIN_MALE describing the real action of that exact interval (Odaya gir, Onu öp). Second person only; never narrate him in third person; izle only for what others do. narrativeChoiceLabel is the story-aware version (names, place, what was just said). Neither promises anything absent from the interval.
- Names: the stable displayName or a verified non-family story role (komşu, patron, ev sahibi). Labels never contain track ids, never kız for an adult, never a family role in intimate wording.
- Uncertain context gets neutral wording (Onunla konuşmaya devam et). Each action also returns narrativeReason, sceneTitle, sceneGoal, storyEvidenceLevel, storyConfidence and storyEvidence.
- Adult labels are explicit, direct and natural, naming the exact verified act without euphemism. Name the visible detail of his move when there is one: grip (saçını tutarak, kalçasını kavrayarak), angle (bacağını omzuna alarak) or her visible answer (kalçalarını oynatmasına izin ver). Generic wording (devam et, ritmik hareket) only when no detail is visible. A route word (vajinal, anal) only with activityTypeConfidence >= 0.90. Never a timestamp, sequence number, emotion or another position's name in a movement label.

7. ADULT SCENES AND POSITIONS (consensual encounters between clearly adult people)
- If adulthood or the act itself is uncertain, keep the description neutral.
- One continuous encounter (opening, oral/manual, positions, climax, aftermath) keeps one adultSceneId; a new one only after a clear narrative, location, participant or time break. adultSceneStartTime/EndTime cover the real scene; postSceneTime is its first continuation.
- Groups: groupScene true and adultParticipantCount only with three or more visible adults. participantTrackIds lists adults in this interval; partnerTrackId is the one adult with MAIN_MALE (MULTI_PARTNER and Birden fazla partner when several at once). A new partner is a new positionOccurrenceId; partner_transition (Partner B'ye geç) only when a playable handoff is visible.
- Canonical positionId only: oral, manual, reverse-cowgirl, seated-facing, prone-bone, legs-up, missionary, cowgirl, spoon, reverse-spoon, standing-rear, rear, seated, standing. Undressing, walking, preparation, conversation and pauses get no positionId.
- For every position return receiverBodyOrientation, receiverSupport, mainMalePosture (how MAIN_MALE's own body is placed), receiverLegs, positionConfigurationConfidence and positionEvidence, from what is seen at start, midpoint and end, never copied from positionId.
- Decide the position with this check, in order; the first true answer wins, and it overrides any label you were about to write:
  1) a mouth on genitals -> oral (both at once, head-to-feet -> oral with oralGiver mutual: the 69; otherwise oralGiver partner or main_male, decided by whose head is between whose legs);
  2) only a hand on genitals -> manual;
  3) she is on top of MAIN_MALE: he lies on his back or sits under her and her weight is on his hips -> facing him: cowgirl, facing away: reverse-cowgirl. His hands on her hips, her hips moving, a lap or the word kucak never prove this while he stands or kneels;
  4) she lies on her back -> legs held up for most of the interval: legs-up, otherwise missionary;
  5) she lies face-down and flat -> prone-bone;
  6) she is on hands and knees -> rear;
  7) she stands bent forward -> standing-rear;
  8) both lie on their sides -> spoon (her back to him) or reverse-spoon;
  9) seated -> seated-facing or seated;  10) standing -> standing.
- mainMalePosture must fit: cowgirl, reverse-cowgirl and seated-facing need lying_back or seated; rear, standing-rear and prone-bone need kneeling, standing, behind or on_top; missionary and legs-up need kneeling, standing or on_top. If it does not fit, the position is wrong.
- Furniture or direction words are never position evidence; leaning is not lying flat.
- Each uninterrupted occurrence has its own positionOccurrenceId, positionStartTime, positionEndTime and positionLabel. End it before a visible change and start the next at its first clear frame; the transition belongs to neither. A later return is a new occurrence. A change of oral giver or route starts a new action and occurrence.
- Route: positionId never decides it. activityType vaginal or anal only when directly visible and consistent at start, midpoint and end (activityTypeConfidence 0.90+ with activityEvidence); otherwise other. Never default to vaginal; with a trans woman receiving, write only the route that is visible.

8. MOVEMENTS, TEMPO AND LOOPS
- Inside a position, every meaningful visible change (tempo, depth, grip, body angle, pause, interaction) is its own action with the same positionId and a label naming what changes. A position longer than about 25 s usually has several such moments; never repeat one label over the whole span and never invent a change. Kissing, caressing or clothing during a position is a separate action.
- movementChange compares a movement with the previous part of the same occurrence: faster, slower, harder, deeper or none. Only a visible change counts.
- movementTempo from visible cadence, compared within this video: slow for the calmest, fast only when consistently rapid, unclear when it cannot be verified.
- audioIntensity from time-aligned sound; femaleProgressRate and maleProgressRate (0.25-2.5) from visible intensity (calm 0.5-0.8, ordinary 1, vigorous 1.5-2.5). nonSpeechAudio, gazeIntensity, observedAffect and bodyResponse only from time-aligned cues; otherwise unclear.
- loopStartTime/loopEndTime: a naturally repeatable interval of at least 5 s fully inside the action, verified at start, midpoint and end; never a frozen frame, cut or transition.
- verifiedSubsequences (see TERMS): for an action longer than about 20 s, list consecutive 10-20 s parts that cover it with the same arrangement, people and camera continuity, cut where his pace or force visibly changes. Each part has its own movementTempo and movementChange (compared with the start of the action) and gets its own label only when a visible detail changes; otherwise [].
- rewardMoments (not choices): her_climax only for a clearly visible climax of the partner (consistent bodily cues, not sound alone); highlight for at most one striking non-final moment per scene. Each 3-45 s with startTime, endTime, a short Turkish label, partnerTrackId, evidence, sourceVerified true. Return [] when nothing qualifies.
- Outcomes: a visible climax is actionType outcome, outcomeType climax, with outcomeStartTime/outcomeEndTime and outcomeLabel; a distinct continuation after it is aftermath. Neither has a positionId or overlaps a loop. outcomeUnlockProgress default 82.

9. CAMERA
- cameraMode: third_person, male_pov (viewpoint reliably his, from visible hands, arms, body and continuity), mixed, uncertain.

10. FINAL SELF-CHECK
- Each action: seen at start, midpoint and end inside this chunk? Does its label describe exactly that interval? Is the actor MAIN_MALE or a partner acting on him? Otherwise fix or drop it.
- Each position: does the 10-step check give the same positionId, and does mainMalePosture fit? Is any route directly visible with confidence 0.90+? Otherwise use other and a neutral label.
- Each character: one stable displayName everywhere? Nothing based only on a guess?
- Every movementChange and rewardMoment visibly there? Nothing in facts[], synopsisTr or labels from imagination, genre expectations or prior memory alone.

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
${castNote ? `Viewer's cast note — the viewer knows this video and states who is in it. Treat it as an established fact for genderIdentity (for example a trans woman: gender female, genderIdentity trans_woman) and apply it to the matching person: ${JSON.stringify(castNote)}
` : ''}`;
}
