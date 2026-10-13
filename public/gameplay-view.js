import { availableChoices, activeSurface, progression } from './gameplay-state.js';
import { syncInteractionSurfaces, mountInteractionPanel } from './interaction-panel.js';

const rendered = new WeakMap();
const positionKey = choice => choice.positionId ? String(choice.positionId) : '';
const movementName = value => ({ rhythmic: 'Ritmik hareket', slow: 'Yavaş hareket',
  moderate: 'Dengeli hareket', fast: 'Hızlı hareket' })[String(value || '').trim().toLowerCase()] || value;

// The reducer owns the exact same choices in normal and fullscreen layouts.
// Chronologically adjacent observations are never turned into alternatives by
// the view; only a verified decision/scene ownership group can do that.
export function phaseVisibleChoices(state) {
  return availableChoices(state);
}

/** The only DOM projection for mobile, desktop and fullscreen. */
export function renderGameplay({ state, player, els, document = globalThis.document }) {
  const progress = progression(state);
  const owningStage = state.graph.stages.find(row => row.id === state.stageId);
  const surface = owningStage ? activeSurface(state) : 'none';
  const choices = phaseVisibleChoices(state);
  const grouped = new Map();
  if (surface === 'panel') for (const choice of choices) {
    const key = positionKey(choice);
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, { key, label: choice.positionLabel || choice.positionId,
      positionId: choice.positionId, occurrenceId: choice.occurrenceId });
  }
  const positions = [...grouped.values()];
  const focusedPositionId = positions.some(row => row.positionId === state.focusedPositionId)
    ? state.focusedPositionId : positions[0]?.positionId;
  // Tabs always show every sourced position. A panel action without a verified
  // position link remains available separately, never under a guessed tab.
  const visibleChoices = surface === 'panel' && positions.length
    ? choices.filter(row => row.positionId === focusedPositionId) : choices;
  const unassignedChoices = surface === 'panel' && positions.length
    ? choices.filter(row => !row.positionId) : [];
  const stageElement = els.video?.closest('.video-stage');
  const fullscreen = Boolean(stageElement && (document?.fullscreenElement === stageElement ||
    document?.webkitFullscreenElement === stageElement));
  const signature = JSON.stringify([state.stageId, state.status, state.error, state.selection?.choiceId,
    state.selection?.index, focusedPositionId, progress, choices.map(row => row.id), fullscreen]);
  if (els.cursorText) els.cursorText.textContent = `${state.cursor.toFixed(1)} sn`;
  if (rendered.get(els) === signature) return;
  rendered.set(els, signature);
  const targets = { story: els.choices, approach: els.approachChoices, panel: els.movementChoices };
  mountInteractionPanel(els.video?.closest('.video-stage'), els.adultInteractionPanel);
  // Remove the old duplicate/source-explorer overlays from the movie canvas.
  stageElement?.querySelector?.('.gameplay-menu-toggle')?.remove?.();
  stageElement?.querySelector?.('.gameplay-source-navigator')?.remove?.();
  for (const target of [...Object.values(targets), els.positionTabs, els.adultQuickChoices]) target?.replaceChildren();
  for (const key of ['foreplaySection', 'categorySection', 'groupPartnerSection',
    'outcomeSection', 'orgasmDecision', 'rhythmControl', 'nextVariantBtn', 'finishAdultSceneBtn']) {
    els[key]?.classList.add('hidden');
  }
  els.adultInteractionPanel?.classList.add('compact-expanded');
  els.adultInteractionPanel?.classList.remove('compact-collapsed');
  els.movementSection?.classList.toggle('hidden', surface !== 'panel');
  els.positionSection?.classList.toggle('hidden', !positions.length);


  const root = targets[surface] || els.choices;
  if (!root) return;
  root.setAttribute('aria-live', 'polite');
  const makeButton = (parent, label, action, className = 'choice gameplay-choice') => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    // Explicit accessible names must not include CSS-generated list numerals
    // and chevrons (which broke voice control and role-based navigation).
    button.setAttribute('aria-label', label);
    button.disabled = false;
    button.addEventListener('click', action);
    parent.appendChild(button);
    return button;
  };
  const selectChoice = choice => {
    void player.select(choice.id);
  };
  const phaseLabel = { STORY: 'Hikâye', APPROACH: 'Yakınlaşma', CORE: 'Etkileşim', INTERLUDE: 'Geçiş',
    OUTCOME: 'Sonuç', AFTERMATH: 'Sahne sonrası' }[progress.phase] || 'Hikâye';
  const chapter = state.graph.chapters.find(row => row.id === state.chapterId);
  const cast = chapter?.cast || [];
  const characterProgress = cast.length
    ? cast.reduce((sum, id) => sum + (state.characters[id]?.progress || 0), 0) / cast.length : 0;
  const info = document.createElement('div');
  info.className = 'meta gameplay-status';
  info.textContent = state.status === 'ended' ? 'Video tamamlandı.' : state.error ||
    (progress.phase === 'AFTERMATH' ? 'Sahne sonrası · Seçimler' :
      `${phaseLabel} · ${surface === 'story' ? 'İlerleme' : 'Lust'} %${Math.round(surface === 'story' ? progress.value : progress.lust)}`);
  root.appendChild(info);
  if (state.status === 'continuing' || !owningStage) {
    // Never show stale choices over source footage between verified chapters.
    syncInteractionSurfaces({ panel: els.adultInteractionPanel, overlay: els.choices,
      approach: els.approachChoices, surface: 'none' });
    return;
  }
  const relationshipRows = Object.values(state.relationships).filter(row =>
    cast.includes(row.from) && cast.includes(row.to) && row.label);
  if (relationshipRows.length) {
    const relationship = document.createElement('small');
    relationship.className = 'gameplay-relationship';
    relationship.textContent = relationshipRows.map(row =>
      `${row.label} · etkileşim %${Math.round(row.progress)}`).join(' / ');
    root.appendChild(relationship);
  }

  // Position -> occurrence -> observed movement. A camera cut stays inside its
  // parent action; a different position/occurrence gets its own navigation tab.
  if (els.positionTabs && positions.length > 1) {
    const familyOccurrences = new Map();
    for (const row of positions) familyOccurrences.set(row.positionId,
      (familyOccurrences.get(row.positionId) || 0) + 1);
    const ordinal = new Map();
    for (const row of positions) {
      const index = (ordinal.get(row.positionId) || 0) + 1;
      ordinal.set(row.positionId, index);
      const label = familyOccurrences.get(row.positionId) > 1 ? `${row.label} · ${index}` : row.label;
      const targetChoice = choices.find(choice => positionKey(choice) === row.key);
      const tab = makeButton(els.positionTabs, label, () => {
        if (targetChoice) selectChoice(targetChoice);
      }, 'position-tab gameplay-position-tab');
      tab.setAttribute('role', 'tab');
      const selected = row.positionId === focusedPositionId;
      tab.setAttribute('aria-selected', String(Boolean(selected)));
      tab.classList.toggle('active', Boolean(selected));
    }
  }
  if (els.positionCount) els.positionCount.textContent = `${positions.length} pozisyon`;

  for (const choice of visibleChoices) {
    const storyIsObservation = surface === 'story' && choices.length === 1 && choice.abstained;
    const repeatingPositionLabel = surface === 'panel' && choice.positionLabel &&
      choice.label.trim().toLocaleLowerCase('tr-TR') === choice.positionLabel.trim().toLocaleLowerCase('tr-TR');
    const label = storyIsObservation ? 'Hikâyeyi oynat' :
      repeatingPositionLabel ? movementName(choice.movementLabel) || choice.label : choice.label;
    const card = makeButton(root, label, () => selectChoice(choice),
      'choice story-choice gameplay-choice gameplay-choice-card');
    card.disabled = false;
    card.dataset.choiceId = choice.id;
    card.dataset.choiceSurface = surface;
    card.setAttribute('aria-pressed', String(state.selection?.choiceId === choice.id));
    // Source timestamps belong in the owner timeline/debug report, not in
    // cinematic choice buttons. Show the action itself, without duration.
  }
  if (unassignedChoices.length) {
    const heading = document.createElement('div');
    heading.className = 'meta gameplay-unassigned-heading';
    heading.textContent = 'Pozisyona bağlanmamış gözlenen eylemler';
    root.appendChild(heading);
    for (const choice of unassignedChoices) {
      const card = makeButton(root, choice.label, () => selectChoice(choice),
        'choice story-choice gameplay-choice gameplay-choice-card');
      card.dataset.choiceId = choice.id;
      card.dataset.choiceSurface = surface;
    }
  }

  // One selection surface only. The former secondary quick-action dock
  // mirrored the same cards and caused stacked/duplicated controls.
  els.adultQuickChoices?.replaceChildren();

  if (state.status === 'error')
    makeButton(root, 'Yeniden dene', () => void player.retry());
  if (state.error && !state.selection && choices.length)
    makeButton(root, 'Videoya devam et', () => void player.continueVideo());
  if (state.status === 'paused') makeButton(root, 'Oynatmaya devam et', () => void player.resume());
  // Stage navigation has its own edge arrows. Do not intermix transport commands
  // with populated choice menus (the original fullscreen UX regression).
  const remainingStageIds = chapter?.stageIds.slice(chapter.stageIds.indexOf(state.stageId) + 1) || [];
  if (!state.selection && !visibleChoices.length) {
    if (progress.nextStageId) makeButton(root, 'Sonraki aşama', () => player.advanceStage());
    else if (remainingStageIds.length) makeButton(root, 'Sonraki aşama', () => player.skipStage());
    else if (progress.completed || !choices.length) {
      if (state.chapterId) makeButton(root, 'Sonraki sahne', () => player.nextChapter());
      if (state.cursor < state.graph.duration - .05)
        makeButton(root, 'Videoya devam et', () => void player.continueVideo());
    }
  }
  // Keep choices visible during verified playback and across fullscreen changes.
  syncInteractionSurfaces({ panel: els.adultInteractionPanel, overlay: els.choices,
    approach: els.approachChoices, surface });
  if (els.adultSceneTitle) els.adultSceneTitle.textContent = 'Doğrulanmış seçimler';
  if (els.adultDockTitle) els.adultDockTitle.textContent = phaseLabel;
  for (const key of ['adultDockPhase', 'adultPhaseBadge', 'adultPhaseTitle'])
    if (els[key]) els[key].textContent = phaseLabel;
  if (els.adultPhaseHint) els.adultPhaseHint.textContent =
    state.graph.clips.some(row => row.visualVerified !== true)
      ? 'Bazı olaylar kaynak analizinde bağımsız görüntü kanıtı olmadan raporlanmış.'
      : 'Görüntüyle doğrulanmış kaynak seçenekleri.';
  if (els.adultFlowStatus) els.adultFlowStatus.textContent =
    `Lust %${Math.round(progress.lust)} · ${progress.sceneEngagements} seçim`;
  if (els.adultDockLustValue) els.adultDockLustValue.textContent = Math.round(progress.lust);
  if (els.adultDockMaleValue) els.adultDockMaleValue.textContent = Math.round(characterProgress);
  if (els.maleProgressText) els.maleProgressText.textContent = `%${Math.round(characterProgress)}`;
  if (els.maleProgressBar) els.maleProgressBar.style.width = `${characterProgress}%`;
  if (els.adultSceneTime && chapter)
    els.adultSceneTime.textContent = `${chapter.startTime.toFixed(1)}–${chapter.endTime.toFixed(1)} sn`;
  if (els.movementCount) els.movementCount.textContent = `${visibleChoices.length + unassignedChoices.length} seçenek`;
  if (els.movementHeading) els.movementHeading.textContent = positions.length
    ? 'Gözlenen hareketler' : 'Gözlenen eylemler';
  if (els.femaleProgressText) els.femaleProgressText.textContent = `%${Math.round(progress.lust)}`;
  if (els.femaleProgressBar) els.femaleProgressBar.style.width = `${progress.lust}%`;
}
