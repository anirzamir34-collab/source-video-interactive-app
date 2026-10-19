// Previous long analysis prompt, kept verbatim so it can be restored with
// ANALYSIS_PROMPT=legacy without a code change.
export function buildLegacyAnalysisPrompt({
  duration, chunkIndex, chunkCount, chunkStart, chunkEnd, timestamps, motionProfile,
  sceneBoundaries, reviewInstructions, conditionalRelationshipInstructions, qualityMode,
  dialogueContext, dialogueSpeakerContext, sensoryAudioContext, storyContextMemory,
  protagonistProfile, protagonistHint
}) {
  return `
SOURCE VIDEO IS THE SINGLE SOURCE OF TRUTH.

COMPLETE CHRONOLOGICAL COVERAGE FOR EVERY CHOICE SURFACE:
- First list every distinct observable event in this chunk in time order, including ordinary story events, spoken decisions with time-aligned support, opening interactions, sustained scene actions, visible changes within them, transitions and aftermath. Then assign each event its supported choiceSurface and actionLevel. Do not let an uncertain specialized classification hide an otherwise visible event.
- For each event separate (1) whether it happened, (2) its source time interval, (3) the people visibly involved, and (4) optional specific descriptions. If (4) is uncertain, keep (1) and (2) when supported; use a neutral accurate label, empty optional fields and a warning. Never claim that a complete interval was analyzed when Gemini could not inspect it.
- Story choices follow actual dialogue or narrative changes. Approach choices describe directly observed opening interactions. Panel choices require a sustained, separately verifiable interaction and a usable source clip. MAIN marks meaningful changes; BONUS marks distinct visible changes within the same scene. Keep every surface on its own source interval; do not turn an uncertain panel classification into a gap in the ordinary timeline.
- A missing or ambiguous frame is not evidence that an entire scene is absent. Record uncertain details without inventing them. Report an analysis gap only for an interval that could not be analyzed at all, with its true start and end.

You receive chronological contact-sheet images sampled from one local video.
Each tile contains its source timestamp. Analyze only directly visible evidence.
Never invent people, actions, dialogue, objects, contact, movement or outcomes.
For every imperative label, verify the named contact point in the actual sampled frames.
When hands or the contact point are occluded, use a neutral visible description;
never guess a body part from posture, previous labels, or category metadata.
A kiss or general touch is an opening interaction, not evidence for a different
activity. Keep positionId, positionLabel and activityType neutral unless the
specific interval directly and consistently supports them.

Identify the recurring male protagonist. Describe only his directly visible
actions in chronological order. Create a new action when visible movement,
tempo, direction, posture, body orientation, contact point, interaction or
scene changes. Never invent alternatives.
Do not impose a fixed action count or collapse separately visible changes into one long summary.
A continuous real action remains a real action when the camera angle changes; distinguish
shot metadata from observable participant movement.

The chunk's timestamps, visual-change profile and detected scene boundaries are given in CHUNK INPUT at the end.
- Treat boundary timestamps as navigation hints, not proof of an action.
- Prefer starting or ending an action near a boundary only when the adjacent frames visibly confirm the change.

DIALOGUE AND SCENE CONTEXT:
The time-aligned dialogue segments, the stable audio speaker registry (voice IDs are NOT visual character IDs) and the time-aligned non-speech audio observations are given in CHUNK INPUT at the end.

- Use dialogue only when its timestamp overlaps the visible scene.
- Use verified spoken meaning to improve scene understanding and Turkish choice wording.
- Distinguish the person speaking, the person being addressed, and an off-screen person being mentioned. Hearing a name does not name the speaker: an addressed name belongs to the addressee only when the visible interaction identifies that person.
- Match a speakerId to a visual participantTrackId only with time-aligned visible speaking evidence. Never match by gender, list order, or the number of people. Record supported matches as speakerIds and voiceMatchEvidence on that character; otherwise leave speakerIds empty.
- Scribe may split one real person into several speakerIds. When multiple speakerIds are each directly matched to the SAME visible recurring character at their own timestamps, put all of those IDs in that character's speakerIds array. This is an identity consolidation, not a new character. Never merge speakerIds merely because only two people are visible.
- For each fact-level recurring character, also return gender as "male", "female" or "uncertain" when directly supported, plus voiceTone and voiceEmotion as short source-grounded descriptors when the audible/visible performance supports them. Use "uncertain" or empty text when not supported; do not infer personality or relationship from voice style.
- Never attribute one speakerId to different people by list order or gender. If diarization merges two distinct speakers, mark the speaker-to-character relationship ambiguous until time-aligned evidence establishes it.
- If no proper name is audible, keep the same visual participantTrackId in every chapter and preserve a short distinctive, directly observed visual description. Generic IDs are not proper names.
- Return facts[], inferences[] and unknowns[] as readable text fields, never nested objects or serialized object placeholders.
- Explicit names and relationship statements in originalText may establish identity even when subtitles and dubbing are disabled. Preserve the exact quotation and source timestamp in evidence. Bind each relationship to both exact character IDs; a quote about someone off-screen must not be assigned to a visible person.
- Dialogue never overrides contradictory visual evidence.
- Non-speech audio may support intensity only when its timestamp overlaps the action. Audio alone never proves pain, pleasure, consent, a relationship or an internal feeling.
- Never invent speech, responses or outcomes.
- Connect dialogue choices only to matching visible MAIN_MALE actions.

STORY ENGINE V1 — EVIDENCE-AWARE NARRATIVE UNDERSTANDING:
Prior verified story memory from earlier chunks is given in CHUNK INPUT at the end.

- Understand the scene as a story, not merely a motion list: identify setting, immediate scene purpose, emotional tone, character roles, relationship clues, goals, conflict/tension and meaningful narrative progression.
- Build story continuity across chunks, but PRIOR MEMORY NEVER OVERRIDES current source frames or current time-aligned dialogue.
- Separate knowledge into three levels only: fact, inference, unknown.
- FACT means directly visible or explicitly stated in time-aligned dialogue. Include a short evidence string and confidence.
- INFERENCE means strongly suggested but not explicit. It must remain phrased as an inference and include evidence/confidence.
- UNKNOWN means the source does not establish it. Never silently promote unknown information into a fact.
- A relationship or background label becomes FACT only when the source explicitly establishes it; appearance, age differences, familiarity and setting are insufficient. Otherwise record the role as uncertain, without guessing.
- Give each recurring adult a stable character entry with id, participantTrackId, displayName, sourceRole, gender, voiceTone, voiceEmotion, speakerIds, voiceMatchEvidence, evidenceLevel, confidence and evidence. Preserve an explicitly spoken proper name exactly; otherwise use the most specific source-grounded story role instead of repeatedly reducing a known character to generic age/gender wording.
- Keep displayName separate from sourceRole and relationships: a displayName is an explicitly established proper name or a stable participant label. Never manufacture possessive identities such as "Danny'nin kadını". If a later chunk establishes the name of an existing track, update that same character entry with the direct evidence.
- Return primaryCharacterId for the exact character addressed by each choice; it must reference that character's id or participantTrackId. List only people involved in the exact action in involvedCharacterIds. Apply these identity rules equally to two-person and group scenes. Do not choose an identity by matching an age/gender description or merely because only two people appear elsewhere in the video.
- Carry verified character names and non-sensitive story roles into sceneTitle, sceneGoal and narrativeChoiceLabel whenever that makes the real action clearer. Keep the same wording across chunks and never rename a recurring character.
- Never infer age, kinship or another sensitive relationship from appearance. If dialogue explicitly establishes a sensitive family relationship, retain it only as neutral factual story context; do not turn that relationship label into sexualized choice wording, a reward, or invented motivation.
- For ordinary non-intimate story actions, relationshipContext may state a verified family, spouse, former-partner or social relationship when the exact two character IDs, fact-level evidence and time-aligned dialogue support it. State who is related to whom; never output a floating role with no character IDs.
- For adult/intimate actions, keep verified relationships in top-level storyContext only. Leave relationshipContext empty and use the verified name or stable participant ID in every playable option.
- Every action must return involvedCharacterIds and primaryCharacterLabel. For ordinary story actions, primaryCharacterLabel is the verified displayName or sourceRole. For an adult/intimate action, use the verified displayName when available; otherwise the same non-family story role or stable visible description used for that character in the story choices, never a kinship title as erotic wording.
- Approach and panel labels continue the same story: write them with the established names/roles, the current place and situation of the scene (as already shown in the story choices), so the intimate choices read as the next beat of that story rather than a detached generic act. Never invent story facts, and never turn a family or step-family relationship into intimate wording.
- narrativeChoiceLabel, label and every BONUS/extra option must explicitly identify the involved recurring character through primaryCharacterLabel whenever more than one character exists in the video. Do not fall back to generic 'kadın', 'erkek', 'genç kız', 'olgun adam', 'biri' or 'partner' when a verified stable identity is available.
- Return top-level storyContext with synopsisTr, currentSceneTitle, currentSceneGoal, setting, emotionalTone, characters[], relationships[], facts[], inferences[], unknowns[].
- Every relationship entry must contain from, to, relation, evidenceLevel, confidence and evidence.
- Relationship direction is explicit: from identifies the reference person, to identifies the other person, and relation describes TO relative to FROM. Add inverse edges only when the evidence establishes both. Never invent a specific role variant.
- In ordinary, non-intimate story choices, prefer an explicitly verified relationship when it clarifies the source action; retain proper names independently. Do not enumerate or infer relationship categories not established by the video or dialogue.
- Return subjectTrackId for the exact actor and primaryCharacterId for the exact addressee in every ordinary story action. In a group, resolve the relationship for that pair only. Qualify it with the reference person's verified name when otherwise ambiguous, without changing the source action.
- Every returned action must additionally contain narrativeChoiceLabel, narrativeReason, sceneTitle, sceneGoal, relationshipContext, storyEvidenceLevel, storyConfidence and storyEvidence.
- narrativeChoiceLabel is the player-facing Turkish story choice. It must describe the meaning of the REAL playable action in context, not invent a branch.
- narrativeChoiceLabel must still map to that action's exact startTime/endTime. Never write a choice whose promised consequence is absent from that exact source segment.
- ORDINARY DIALOGUE AND STORY CHOICES ONLY: identify the exact onset and end
  of each DISTINCT visible or spoken event. Do not slice an ongoing story into
  arbitrary fixed-length windows just to produce more choices.
- When a later ordinary event becomes visible, end the preceding choice
  BEFORE that next event's onset. One real action (e.g. someone taking an
  object) must not be presented first as the ending of an unrelated clip
  and again as the entirety of the next choice.
- Two ordinary story choices may share an exact startTime only when they are
  genuine alternatives grounded in that same observed decision instant.
  Sequential events at different timestamps are not simultaneous alternatives.
- Derive timestamps from the supplied source frames and aligned dialogue;
  do not round or evenly distribute decisions across a scene. When the
  frames cannot resolve a precise boundary, keep a single neutral
  source-grounded observation instead of inventing two adjacent actions.
- Apply these chronological rules to ALL source videos, characters and
  non-intimate scene types. Do not change critical visual verification for
  other action classes.
- If relationship/background context is uncertain, use neutral story wording such as 'Onunla konuşmaya devam et', 'Neden geldiğini sor' or another source-grounded action instead of asserting an unsupported relationship.
- Prefer story-aware wording over mechanical wording when evidence supports it: scene intention + interaction + verified action. Do not replace precise sexual-position controls with fictional dialogue or outcomes.

PROTAGONIST IDENTITY LOCK:
The current locked profile and the optional user visual description are given in CHUNK INPUT at the end.

- Use MAIN_MALE only when an adult male is actually present and identifiable in this chapter.
- The opening chapter may contain only women; that is NOT proof that the
  video lacks a male protagonist, and does not justify inventing one.
- If no video-wide profile is verified, a user visual description can guide
  matching only when the source frames actually support it.
- If a verified video-wide profile exists, match the same person across
  clothing, pose, distance, and camera changes. A contradictory source frame
  must stay unresolved rather than being relabeled.
- When the profile is unresolved, keep non-protagonist observations as neutral
  chronological story context; do not manufacture male-player actions.
- With no user description, MAIN_MALE is the adult male with the most screen presence and story agency across the video; a male point-of-view camera owner counts as MAIN_MALE. Once chosen, keep the same person for the whole video.
- Distinguish all other males as OTHER_MALE and never convert their actions into player choices.
- Use face, hair, facial hair, skin tone, body build, clothing, accessories, position and scene continuity together.
- Never switch MAIN_MALE merely because another male becomes larger or more central in the frame.
- If identity is uncertain, never assign another person's action to MAIN_MALE. Keep the visible event as neutral story context with uncertain participant identity when its interval is supported; omit a player choice only if no supported player action can be identified.
- Return a short stable protagonistProfile describing MAIN_MALE with persistent visible identity anchors.
- Every returned action must belong to MAIN_MALE or to the male-POV camera controlled by MAIN_MALE.
CHUNK RULES:
- Return actions only when startTime and endTime are inside this chunk.
- Examine this short interval deeply instead of summarizing the whole video.
- Prefer atomic visible actions and meaningful changes over broad multi-minute descriptions.
- A MAIN action marks a major scene, position, location, or interaction change.
- BONUS actions capture visible tempo, touch, clothing, posture, body, or camera changes inside the scene.
- Consecutive atomic actions may touch at their boundaries.
- MAIN and BONUS evidence may belong to the same scene, but every returned action must have its own playable time segment.
- ADULT SCENE CHOICES: When a clearly consensual sexual interaction between visible adults is actually shown, write the label field in explicit, direct and natural Turkish, naming that exact verified sexual action without euphemism.
- Name the visibly verified roles, position, contact, direction and tempo when they distinguish one real action from another.
- Do not censor, soften, euphemize or replace verified adult actions with vague labels such as "devam et", "yakınlaş", "pozisyonu değiştir" or "hareketi sürdür".
- Each adult choice must distinguish a genuinely different playable action or variation that exists inside this chunk and must seek to its exact startTime. Name the visible actor and their particular observed movement or contact; a bare position name, tempo or generic "ritmik hareket" is not a complete player choice when the source verifies a more specific act.
- Never invent an adult action, body contact, position, participant, consent, intensity or outcome that is not clearly visible in the source video.
- If adulthood or the visible action is uncertain, keep the description neutral and limited to the clearly observable movement.
- For chunks after the first one, introEndTime and playStartTime must equal chunkStart.
- Never create filler merely to reach a target count.

TWO-LEVEL DEEP ANALYSIS:
- MAIN actions are real scene, position, body-arrangement or major interaction changes.
- BONUS actions are meaningful visible changes inside the same main scene: pace/rhythm change, acceleration, slowing, pause, kiss, touch, hand placement, posture, body transition, clothing removal or another clearly visible male action.
- Do not represent a several-minute scene with one broad action when meaningful changes occur inside it.
- Keep the same sceneId for BONUS actions until a new MAIN action begins.
- Give actions in one visibly continuous physical location the same locationId, even when a new MAIN action changes the interaction. Change locationId at an observed location cut or move; leave it empty when the location cannot be verified. It identifies source continuity, never an imagined branch.
- Determine each action boundary only from observed changes in visible movement, context, speaker or interaction.
- Continuous unchanging footage is one action regardless of length. A change is a new action only if it is observable, not because enough time passed.
- Use independently verified changes in posture, direction, contact, position, tempo, cast or camera continuity to split a long scene.
- Do not divide intervals into evenly spaced clips and never duplicate the same action just to increase choices.
- Actions must be chronological, forward-moving and non-overlapping.

INTRO:
- Inspect the opening source frames and timestamped dialogue for logos, title cards, advertisements, previews and other non-story material.
- Only the contiguous non-story material preceding the first verified narrative event may be excluded. Once narrative action/dialogue begins, later titles are scene transitions, not a new intro.
- introEndTime is the first verified narrative frame. If no distinct opening non-story material is demonstrated, report 0 and preserve the source opening.
- Do not classify character introductions or genuine dialogue as advertisements merely because they occur early.
- Create no action before a positively detected introEndTime; preserve the source timestamps of every subsequent verified action.
- playStartTime must equal introEndTime.

CAMERA:
- third_person: male protagonist is externally visible.
- male_pov: viewpoint is reliably from the male protagonist.
- mixed: visible transition between both.
- uncertain: insufficient evidence.
- Do not discard male POV merely because his full body is absent. Use visible hands, arms, camera movement, body position and continuity.
- Never infer an invisible action without evidence.

Return ONLY valid JSON with this exact shape:
{
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
      "movementType": "",
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
}

Rules:
- Assign exactly one choiceSurface to each source action: story for dialogue and ordinary narrative actions, approach for directly verified opening interactions, or panel for an already verified panel control. Supply choiceSurfaceEvidence and choiceSurfaceConfidence for that specific interval. A directly visible opening physical interaction before the first verified position belongs to approach even if dialogue accompanies it: touching, caressing, kissing, hugging and removing or opening clothing are always approach, never story. Oral and manual sexual activity are positions (panel), not approach; a verbal command, a partner's reaction or a coercive exchange remains story. Never infer contact from dialogue or the later position.
- Speech occurring during an action does not change its surface. Walking, sitting, watching, listening and camera changes stay story unless the supplied visual evidence independently proves another category.
- Never combine separate source actions from different surfaces into one option or extend their timestamps across a category boundary. A conversation mentioning an action is not visual evidence that it happened.
- timestamps must be within 0 and the video duration given in CHUNK INPUT
- startTime must be smaller than endTime
- no duplicate or invented actions; return separate chronological atomic segments
- sort actions chronologically
- if evidence is insufficient, omit the action
- no action may begin before introEndTime
- playStartTime must equal introEndTime
- MAIN and BONUS actions must reflect visible evidence
- Turkish labels must be short and directly describe the male action
- Every UI-facing string must be natural Turkish: label, narrativeChoiceLabel, sceneTitle, sceneGoal, positionLabel, movementType and outcomeLabel. Preserve proper names. Translate only what the supplied source evidence supports; never add meaning while translating.
- Detect every verified adult scene boundary and mark adultScene true only inside that real scene.
- Set one stable adultSceneId for every action belonging to the same adult scene.
- Scene IDs and scene envelopes describe chronology only. Conversation, pauses and camera changes inside an envelope keep their independently verified choiceSurface; do not turn them into opening interactions or panel controls.
- Treat one continuous consensual intimate encounter as one adultScene across foreplay, oral/manual activity, position changes, climax and aftermath. Do not create a new adultSceneId merely because the interaction changes from touching/undressing to a sexual position or from one position to another.
- Start a new adultSceneId only after a clear narrative, location, participant or substantial time break.
- A verified partner switch inside one continuous group encounter is not a new adultSceneId; keep the encounter together and separate it with partnerTrackId plus a new positionOccurrenceId.
- Detect a position only when the source visibly shows a stable adult-act body configuration sustained over time; then use actionType "position".
- Never classify undressing, dressing, walking, approaching, preparation, conversation, camera changes, pauses or generic standing/sitting as positions.
- Foreplay and non-position actions may remain chronological main/bonus actions, but must not receive a positionId or appear in position tabs.
- Merge duplicate detections only when they describe the same continuous occurrence and their time ranges overlap; never bridge separate appearances of the same position into one long range.
- Give every verified position a stable positionId, exact Turkish positionLabel, positionStartTime and positionEndTime.
- Keep positionId as the canonical semantic position family. Give each uninterrupted occurrence of that family a stable positionOccurrenceId; if the same position returns later after another position, transition, cut, or real time gap, it must have a different positionOccurrenceId.
- GROUP/SWINGER SCENES: When three or more clearly adult participants are visibly present in the same consensual encounter, set groupScene true and adultParticipantCount to the directly verified count. Otherwise keep groupScene false; never infer off-screen participants.
- Give every visible adult a stable neutral participantTrackId such as MAIN_MALE, PARTNER_A, PARTNER_B. Reuse the same ID from face, hair, body, clothing and scene continuity; never use a real-world identity or infer a relationship.
- participantTrackIds must list only adults directly involved in that exact action interval. partnerTrackId is the one adult directly paired with MAIN_MALE in that interval. partnerLabel must use that character's verified displayName when available; otherwise the same non-family story role the story choices use for that character (e.g. komşu, patron, dedektif, ev sahibi); otherwise a short visible description that stays stable across chunks (e.g. sarışın kadın). Use a neutral Partner A or Partner B only when none of these exists.
- If one exact position interval visibly involves MAIN_MALE with multiple partners simultaneously, use partnerTrackId MULTI_PARTNER, list every involved adult in participantTrackIds and use the neutral partnerLabel Birden fazla partner. Do this only from direct interval evidence.
- When the same canonical position occurs with a different partnerTrackId, end the previous position occurrence and create a new positionOccurrenceId. They are separate playable positions and must never be merged merely because positionId is the same.
- Set partnerSwitch true only when the frames visibly show MAIN_MALE ending interaction with previousPartnerTrackId and beginning interaction with partnerTrackId. Emit the visible transition as actionType partner_transition with a direct Turkish label such as Partner B'ye geç only when the transition itself has a valid playable interval.
- A partner_transition is chronology metadata, never foreplay and never a Lust-building opening choice. It may connect an already-started partner-specific occurrence to the next verified partner-specific position, but it must never be offered before the first verified position in the encounter.
- Every partner_transition must contain two different non-empty IDs: previousPartnerTrackId for the directly preceding partner and partnerTrackId for the directly following partner. If either identity or the handoff interval is uncertain, do not emit partner_transition.
- If the edit cuts directly to a different partner without showing the transition, do not invent a partner_transition clip. Start the new partner-specific position at its first verified frame instead.
- Set activityType to oral, manual, vaginal, anal, or other only from direct visible evidence; never guess when evidence is unclear.
- CRITICAL: positionId never determines penetration route. Missionary, cowgirl, rear, standing-rear, standing, spoon and any other body position can be vaginal or anal. Never default a penetrative position to vaginal.
- Classify vaginal only when the source frames directly verify vaginal penetration; classify anal only when the source frames directly verify anal penetration. Body angle, position name, dialogue, prior activity, or statistical likelihood are not sufficient by themselves.
- For a specific activity classification, require direct consistent visual support at the action start, midpoint and end. If that detail is occluded or ambiguous, set activityType to other without discarding an otherwise verified scene action.
- Set activityTypeConfidence from 0.0 to 1.0 for the penetration-route classification specifically, independent of general action confidence. Be conservative. A vaginal/anal claim should reach 0.90 only when direct visual evidence is clear and consistent.
- Set activityEvidence to a brief description of the directly visible evidence supporting activityType. Leave it empty for other/uncertain route. Never use dialogue alone as activityEvidence.
- The Turkish label may say "vajinal" only when activityType is vaginal with activityTypeConfidence >= 0.90 and direct activityEvidence. It may say "anal" only when activityType is anal with the same evidence standard. Otherwise the label must name only the verified position/action without claiming penetration route.
- If the visible route changes between vaginal and anal while the body position stays the same, end the previous action at the verified transition and create a new action with a new positionOccurrenceId. Never carry the previous activityType across that transition.
- Verify every position and internal movement against its exact start frame, midpoint frame and end frame from the source video.
- For every position, independently return receiverBodyOrientation, receiverSupport, positionConfigurationConfidence and positionEvidence from the visible body arrangement at start, midpoint and end. Never copy these fields from positionId or positionLabel.
- Position names follow the visible body arrangement: on hands and knees with the partner behind is rear (doggy-style); bent over while standing with the partner behind is standing-rear; sitting astride the partner facing him is cowgirl (on_top_facing + straddling) and facing away is reverse-cowgirl (on_top_away + straddling). A receiver sitting on the partner's lap astride is cowgirl or reverse-cowgirl, not seated and never rear.
- Cowgirl requires the receiving partner to be visibly above MAIN_MALE and straddling him. Prone-bone requires the receiving partner's face-down torso/abdomen to remain visibly supported flat with low hips while MAIN_MALE is behind. These configurations are mutually exclusive.
- If a clip changes between straddling-on-top and face-down-flat, split it exactly at the visible transition. The transition interval must not be an internal movement of either position.
- The Turkish label must describe what is visibly happening in the source interval. If the midpoint does not support a specific label, replace it with a neutral supported description; omit the item only if the underlying event or interval cannot be verified.
- A position movement must describe a visible change while the same canonical body configuration is maintained. Do not attach kissing, caressing, breast touching, clothing adjustment, transition, dialogue or generic excitement to a penetrative position; emit it as a separate warm-up action or omit it.
- Do not use penetration-route words (vaginal/anal/penetration), position-transition words (turning, guiding, changing position) or a different position name as a movement label. Those belong to a separately verified occurrence; otherwise omit the action.
- All returned times are absolute source-video seconds, never scene-relative or chunk-relative seconds.
- Never attach a label detected in one part of the video to an earlier or later segment.
- Position and movement choices must seek to their own verified visible segment, not merely to the parent adult-scene start.
- When sampled frames conflict about a specific classification, remove that classification and add a warning. Preserve the source event with neutral wording when its existence and interval remain supported.
- Inside each position, detect every meaningful real change in tempo, movement, body angle, pause, intensity, emotion or interaction.
- For every action, fuse only time-aligned evidence: audible non-speech intensity, visible gaze duration, facial expression, posture and body response. Report observable cues, not hidden mental states.
- Never claim pain, pleasure, happiness, fear, consent or climax from one ambiguous facial expression, sound or body movement. Use observedAffect unclear unless multiple consistent cues support a cautious visible description.
- Use only these canonical positionId values consistently: oral, manual, reverse-cowgirl, seated-facing, prone-bone, legs-up, missionary, cowgirl, spoon, reverse-spoon, standing-rear, rear, seated, standing. Do not create other-stable-N or another custom canonical name; omit a classification that cannot be supported.
- A furniture or direction word is never position evidence by itself: "koltuğun arkasına", "arkaya yönlendir", "ağzından öp" and ordinary hand contact must not become rear, oral or manual position families.
- rear requires a clearly visible from-behind body configuration; standing-rear additionally requires visible standing lower-body support. A bent or leaning torso does not by itself mean a change to a lying configuration. If the support and body arrangement cannot be established from the supplied frames, omit the classification.
- Distinguish support from torso angle: leaning against furniture is not automatically lying flat. Do not infer support from a cropped torso shot; require visible support evidence from the same uninterrupted interval. A camera rotation or close-up alone must not change the canonical label.
- Use prone-bone only when the receiving partner is visibly lying face-down/flat with hips low while penetration is from behind. Do not collapse prone-bone into rear/doggy, missionary, spoon or a generic lying position.
- positionId, positionLabel and the visible body configuration described by label must agree. If they conflict, omit the position instead of guessing.
- Use missionary only when the receiving partner is visibly below/on their back and MAIN_MALE is visibly above/front-facing in that configuration.
- Distinguish cowgirl from reverse-cowgirl by the partner's orientation RELATIVE TO MAIN_MALE, never by which side faces the camera. Camera angle, a rear close-up, cropping, or a cut cannot by itself make cowgirl become reverse-cowgirl.
- Use cowgirl only when the partner is visibly on top/straddling MAIN_MALE and the same source frames verify that the partner is facing toward him.
- Use reverse-cowgirl only when the partner is visibly on top/straddling MAIN_MALE and the same source frames verify that the partner's torso/head remain facing away from him at the start, midpoint and end of the interval.
- If the partner is clearly on top but facing direction relative to MAIN_MALE cannot be verified from the supplied frames, do not guess between cowgirl and reverse-cowgirl; omit the canonical position classification and add a warning.
- Use seated-facing only when partners are visibly seated/lap-positioned and facing each other. Use seated only for other clearly seated sexual configurations.
- Use legs-up only when legs are visibly raised in a sustained stable configuration. Do not use it for a brief transition.
- Use reverse-spoon only when side-lying orientation is visibly the reverse/back-facing spoon configuration. Do not collapse it into spoon.
- When the visible body configuration changes from one canonical position to another, end the previous occurrence before the change and start a new occurrence at the first clearly verified frame of the new position.
- Two labels describing the same visible body configuration must reuse one canonical positionId; wording, tempo, camera angle, or minor pose variation must never create another position.
- Oral activity, manual activity, undressing, and transitions are separate position families and must never appear beneath missionary, rear, standing-rear, cowgirl, spoon, or another penetrative position.
- A movement may belong to a position only when its entire loopStartTime-loopEndTime interval is visibly contained inside that exact positionStartTime-positionEndTime range.
- Reject an unsupported position or movement classification when the claimed configuration is not visible at its start, midpoint and end. Retain a verified scene event without that classification when it has a usable source interval.
- Every internal change must reuse its parent positionId and have a concise movementType and Turkish label.
- Internal movement labels must name the actor and the directly visible change in what they do, including the particular hand placement or interaction only if verified in that exact interval. Tempo words such as hızlı or ritmik may qualify an observed action but must not replace the action itself. When the evidence supports only a stable pose or pace, say only what is observable; never invent contact to make a label more vivid.
- Never put timestamps, duration, sequence numbers, "gerçek kesit", breathing, moaning, gaze, emotion, appearance or confidence text inside an internal movement label. Those belong only to metadata.
- Set movementTempo from directly visible cadence only. Use slow, moderate or fast for stable segments; split a changing cadence into separate 5+ second verified segments when the source frames resolve the change and its boundaries. Use unclear when speed cannot be verified.
- Oral contact (a mouth on genitals) is always positionId oral for that interval, whatever the body arrangement; never name it cowgirl, reverse-cowgirl or another penetrative position. A penetrative position name requires visible penetration in that exact interval.
- Each panel label must name what is visibly done in that exact interval (e.g. bacaklarını kaldır, onu ters çevir, kucağına al). When a visible body change happens (legs raised, turned over, moved on top), start a new segment at that change so the label matches the first frames. Never use an intensifier such as daha derin or daha hızlı unless that change itself is the dominant visible difference.
- Do not default to moderate: compare segments within the same video and mark the visibly calmest ones slow and the visibly most rapid or vigorous ones fast. Set audioIntensity from time-aligned audible intensity the same way (low/moderate/high), and femaleProgressRate from visible motion intensity (calm 0.5–0.8, ordinary 1, vigorous 1.5–2.5).
- Use fast only when repeated motion is visibly and consistently fast across the complete interval. Put words such as sert, derin or güçlü in movementType/label only when that exact quality is directly visible throughout the same time-aligned segment; never infer it from dialogue, audio alone or the surrounding adult scene.
- These explicit movementTempo and movementType observations control the optional on-screen sex interaction button. If no source-verified fast, hard or deep interval exists, do not manufacture one and allow the button to remain unavailable for the entire video.
- Do not force a fixed number of internal changes. Return exactly as many distinct changes as the source visibly contains.
- Do not split tiny repetitions into fake choices and do not merge genuinely different changes.
- A sustained position longer than about 25 seconds normally contains several visibly different moments (tempo or depth change, different hand placement or grip, changed body angle, a pause and restart, a different camera framing of the same act). Return each visibly different moment as its own chronological action of the same position, typically 8-20 seconds, with its own short Turkish label describing what visibly happens in that moment. Never repeat one label for the whole span and never invent a change the frames do not show.
- For a long continuous action, return verifiedSubsequences only when source frames independently establish natural start and end boundaries for 5+ second playable segments. Use stable body configuration, participants, camera continuity and observed motion. Return [] if the supplied frames cannot support at least two separate boundaries. Never divide an interval at equal time steps or claim a camera cut alone changes the action.
- loopStartTime and loopEndTime must define a naturally repeatable real interval inside the action and position.
- A position and every selectable movement loop must each be at least 5.0 seconds long; omit anything shorter. Require source frames to verify the start, midpoint and end of the whole interval. It may be extended only across visibly continuous footage of the same movement and position; otherwise omit that internal choice.
- Never return one-frame, frozen-frame, transition, cut, camera-change or seek-unstable loops.
- adultSceneStartTime and adultSceneEndTime must cover the real scene; postSceneTime must point to its first real continuation.
- maleProgressRate and femaleProgressRate are game pacing weights from 0.25 to 2.5 based on visible motion intensity and duration. Use measured slow, moderate and fast movement conservatively; do not fill every action with 1 by default when its visible tempo differs.
- When the source visibly contains a real climax/final segment inside the adult scene, emit it as actionType "outcome", outcomeType "climax", with exact outcomeStartTime/outcomeEndTime and a short outcomeLabel. Do not assign positionId to an outcome.
- When the source visibly contains a distinct post-final continuation inside the same adult scene, emit it as actionType "aftermath", outcomeType "aftermath", with exact outcomeStartTime/outcomeEndTime. Do not convert aftermath into a position or movement loop.
- outcomeUnlockProgress is a gameplay hint only; use 82 by default and never use it to invent or extend footage. If no verified outcome or aftermath exists, keep outcomeType "none" and do not fabricate one.
- Outcome and aftermath boundaries must be directly source-verified and must never overlap a selectable movement loop.
- Never invent any position, movement, transition, outcome or label absent from the source frames.

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
