import { availableChoices, activeSurface, progression, nextPlayableClip } from './gameplay-state.js';
import { syncInteractionSurfaces, mountInteractionPanel } from './interaction-panel.js';

const rendered = new WeakMap();

/** One DOM projection for desktop, mobile and fullscreen. No game state writes. */
export function renderGameplay({ state, player, els, document = globalThis.document }) {
  const surface = activeSurface(state), progress = progression(state);
  const choices = availableChoices(state);
  const signature = JSON.stringify([state.stageId, state.status, state.error, state.selection?.choiceId,
    state.selection?.index, progress, choices.map(row => row.id)]);
  if (els.cursorText) els.cursorText.textContent = `${state.cursor.toFixed(1)} sn`;
  if (rendered.get(els) === signature) return;
  rendered.set(els, signature);
  const targets = { story: els.choices, approach: els.approachChoices, panel: els.movementChoices };
  mountInteractionPanel(els.video?.closest('.video-stage'), els.adultInteractionPanel);
  for (const target of Object.values(targets)) target?.replaceChildren();
  for (const key of ['foreplaySection', 'categorySection', 'groupPartnerSection', 'positionSection',
    'outcomeSection', 'orgasmDecision', 'rhythmControl', 'nextVariantBtn', 'finishAdultSceneBtn']) els[key]?.classList.add('hidden');
  els.movementSection?.classList.remove('hidden');
  const root = targets[surface] || els.choices;
  if (!root) return;
  root.setAttribute('aria-live', 'polite');
  const button = (label, action, className = 'choice story-choice') => {
    const element = document.createElement('button');
    element.type = 'button'; element.className = className; element.textContent = label;
    element.addEventListener('click', action); root.appendChild(element); return element;
  };
  const phaseLabel = { STORY: 'Hikâye', APPROACH: 'Yakınlaşma', CORE: 'Etkileşim', OUTCOME: 'Sonuç', AFTERMATH: 'Sahne sonrası' }[progress.phase];
  const chapter = state.graph.chapters.find(row => row.id === state.chapterId);
  const cast = chapter?.cast || [];
  const characterProgress = cast.length ? cast.reduce((sum, id) => sum + (state.characters[id]?.progress || 0), 0) / cast.length : 0;
  const copy = document.createElement('div'); copy.className = 'meta gameplay-status';
  copy.textContent = state.status === 'ended' ? 'Video tamamlandı.' : state.error ||
    `${phaseLabel} · ${surface === 'story' ? 'İlerleme' : 'Lust'} %${Math.round(progress.value)}`;
  root.appendChild(copy);
  const relationshipRows = Object.values(state.relationships).filter(row => cast.includes(row.from) && cast.includes(row.to) && row.label);
  if (relationshipRows.length) {
    const relationship = document.createElement('small'); relationship.className = 'gameplay-relationship';
    relationship.textContent = relationshipRows.map(row => `${row.label} · etkileşim %${Math.round(row.progress)}`).join(' / ');
    root.appendChild(relationship);
  }
  for (const choice of choices) {
    const card = button(choice.label, () => void player.select(choice.id),
      `choice story-choice gameplay-choice ${surface === 'approach' ? 'approach-choice' : ''}`);
    card.dataset.choiceId = choice.id; card.dataset.choiceSurface = surface;
    card.disabled = state.status === 'seeking';
    card.setAttribute('aria-pressed', String(state.selection?.choiceId === choice.id));
    const details = document.createElement('small');
    const clips = choice.clipIds.map(id => state.graph.clips.find(row => row.id === id));
    details.textContent = `${clips.length} kesit · ${clips.map(row => `${row.startTime.toFixed(1)}–${row.endTime.toFixed(1)}`).join(',')} sn`;
    card.appendChild(details);
  }
  if (state.status === 'error') button('Yeniden dene', () => void player.retry());
  if (state.error && !state.selection && choices.length) button('Videoya devam et', () => void player.continueVideo());
  if (state.status === 'paused') button('Oynatmaya devam et', () => void player.resume());
  if (progress.nextStageId && !state.selection) button('Sonraki aşama', () => player.advanceStage());
  if (!state.selection && (progress.completed && !progress.nextStageId || !choices.length)) {
    if (state.chapterId) button('Sonraki sahne', () => player.nextChapter());
    if (state.cursor < state.graph.duration - .05) button('Videoya devam et', () => void player.continueVideo());
  }
  // Explicit skip is always actionable, but never awards progress or unlocks.
  if (choices.length) button('Sahneyi geç', () => player.nextChapter(), 'choice gameplay-skip');
  syncInteractionSurfaces({ panel: els.adultInteractionPanel, overlay: els.choices,
    approach: els.approachChoices, surface });
  const clip = nextPlayableClip(state);
  if (els.adultSceneTitle) els.adultSceneTitle.textContent = clip ? `Kaynak · ${clip.startTime.toFixed(1)} sn` : 'Doğrulanmış seçimler';
  if (els.adultDockTitle) els.adultDockTitle.textContent = phaseLabel;
  for (const key of ['adultDockPhase', 'adultPhaseBadge', 'adultPhaseTitle']) if (els[key]) els[key].textContent = phaseLabel;
  if (els.adultPhaseHint) els.adultPhaseHint.textContent = 'Oynattığın seçimler ve keşfettiğin farklı eylemlerle ilerle.';
  if (els.adultFlowStatus) els.adultFlowStatus.textContent = `Lust %${Math.round(progress.value)} · ${progress.playedChoices} seçim`;
  if (els.adultDockLustValue) els.adultDockLustValue.textContent = Math.round(progress.value);
  if (els.adultDockMaleValue) els.adultDockMaleValue.textContent = Math.round(characterProgress);
  if (els.maleProgressText) els.maleProgressText.textContent = `%${Math.round(characterProgress)}`;
  if (els.maleProgressBar) els.maleProgressBar.style.width = `${characterProgress}%`;
  if (els.adultSceneTime && chapter) els.adultSceneTime.textContent = `${chapter.startTime.toFixed(1)}–${chapter.endTime.toFixed(1)} sn`;
  if (els.movementCount) els.movementCount.textContent = `${choices.length} seçenek`;
  if (els.movementHeading) els.movementHeading.textContent = 'Gözlenen eylemler';
  if (els.femaleProgressText) els.femaleProgressText.textContent = `%${Math.round(progress.value)}`;
  if (els.femaleProgressBar) els.femaleProgressBar.style.width = `${progress.value}%`;
  if (els.cursorText) els.cursorText.textContent = `${state.cursor.toFixed(1)} sn`;
}
