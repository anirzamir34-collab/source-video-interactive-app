import { availableChoices, activeSurface, progression, nextPlayableClip } from './gameplay-state.js';
import { syncInteractionSurfaces, mountInteractionPanel } from './interaction-panel.js';

const rendered = new WeakMap();
const selectedPosition = new WeakMap();
const openedDuringPlayback = new WeakMap();
const positionKey = choice => choice.positionId ? String(choice.positionId) : '';

/** The only DOM projection for mobile, desktop and fullscreen. */
export function renderGameplay({ state, player, els, document = globalThis.document }) {
  const surface = activeSurface(state), progress = progression(state);
  const choices = availableChoices(state);
  const grouped = new Map();
  if (surface === 'panel') for (const choice of choices) {
    const key = positionKey(choice);
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, { key, label: choice.positionLabel || choice.positionId,
      positionId: choice.positionId, occurrenceId: choice.occurrenceId });
  }
  const positions = [...grouped.values()];
  const saved = selectedPosition.get(els);
  const activePosition = saved?.stageId === state.stageId && grouped.has(saved.key)
    ? saved.key : positions[0]?.key || '';
  // While source footage is playing, the surface is a minimal playback
  // control, not another interactive decision superimposed on the shot.
  const selectedChoice = state.selection
    ? state.graph.choices.find(choice => choice.id === state.selection.choiceId) : null;
  const visibleChoices = state.selection ? choices : activePosition
    ? choices.filter(choice => positionKey(choice) === activePosition || !positionKey(choice)) : choices;
  const open = state.status === 'error' || (openedDuringPlayback.get(els)?.selectionId === state.selection?.id &&
    openedDuringPlayback.get(els)?.open);
  const signature = JSON.stringify([state.stageId, state.status, state.error, state.selection?.choiceId,
    state.selection?.index, progress, choices.map(row => row.id), activePosition, open]);
  if (els.cursorText) els.cursorText.textContent = `${state.cursor.toFixed(1)} sn`;
  if (rendered.get(els) === signature) return;
  rendered.set(els, signature);
  const targets = { story: els.choices, approach: els.approachChoices, panel: els.movementChoices };
  mountInteractionPanel(els.video?.closest('.video-stage'), els.adultInteractionPanel);
  const stageElement = els.video?.closest('.video-stage');
  let toggle = stageElement?.querySelector?.('.gameplay-menu-toggle');
  if (stageElement && !toggle) {
    toggle = document.createElement('button'); toggle.type = 'button';
    toggle.className = 'gameplay-menu-toggle'; stageElement.appendChild(toggle);
  }
  if (toggle) {
    toggle.hidden = !state.selection;
    toggle.textContent = open ? 'Seçenekleri kapat' : 'Seçenekler';
    toggle.onclick = () => {
      openedDuringPlayback.set(els, { selectionId: state.selection?.id, open: !open });
      rendered.delete(els); renderGameplay({ state, player, els, document });
    };
  }
  for (const target of [...Object.values(targets), els.positionTabs, els.adultQuickChoices]) target?.replaceChildren();
  for (const key of ['foreplaySection', 'categorySection', 'groupPartnerSection',
    'outcomeSection', 'orgasmDecision', 'rhythmControl', 'nextVariantBtn', 'finishAdultSceneBtn']) {
    els[key]?.classList.add('hidden');
  }
  els.adultInteractionPanel?.classList.add('compact-expanded');
  els.adultInteractionPanel?.classList.remove('compact-collapsed');
  els.movementSection?.classList.toggle('hidden', surface !== 'panel');
  els.positionSection?.classList.toggle('hidden', !positions.length || Boolean(state.selection));

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
  const phaseLabel = { STORY: 'Hikâye', APPROACH: 'Yakınlaşma', CORE: 'Etkileşim',
    OUTCOME: 'Sonuç', AFTERMATH: 'Sahne sonrası' }[progress.phase] || 'Hikâye';
  const chapter = state.graph.chapters.find(row => row.id === state.chapterId);
  const cast = chapter?.cast || [];
  const characterProgress = cast.length
    ? cast.reduce((sum, id) => sum + (state.characters[id]?.progress || 0), 0) / cast.length : 0;
  const info = document.createElement('div');
  info.className = 'meta gameplay-status';
  info.textContent = state.status === 'ended' ? 'Video tamamlandı.' : state.error ||
    `${phaseLabel} · ${surface === 'story' ? 'İlerleme' : 'Lust'} %${Math.round(surface === 'story' ? progress.value : progress.lust)}`;
  root.appendChild(info);
  if (state.status === 'continuing') {
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
  if (els.positionTabs && positions.length && !state.selection) {
    const familyOccurrences = new Map();
    for (const row of positions) familyOccurrences.set(row.positionId,
      (familyOccurrences.get(row.positionId) || 0) + 1);
    const ordinal = new Map();
    for (const row of positions) {
      const index = (ordinal.get(row.positionId) || 0) + 1;
      ordinal.set(row.positionId, index);
      const label = familyOccurrences.get(row.positionId) > 1 ? `${row.label} · ${index}` : row.label;
      const tab = makeButton(els.positionTabs, label, () => {
        selectedPosition.set(els, { stageId: state.stageId, key: row.key });
        rendered.delete(els);
        renderGameplay({ state, player, els, document });
      }, 'position-tab gameplay-position-tab');
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(activePosition === row.key));
      tab.classList.toggle('active', activePosition === row.key);
    }
  }
  if (els.positionCount) els.positionCount.textContent = `${positions.length} pozisyon`;

  for (const choice of visibleChoices) {
    const storyIsObservation = surface === 'story' && choices.length === 1 && choice.abstained;
    const repeatingPositionLabel = surface === 'panel' && choice.positionLabel &&
      choice.label.trim().toLocaleLowerCase('tr-TR') === choice.positionLabel.trim().toLocaleLowerCase('tr-TR');
    const label = storyIsObservation ? 'Hikâyeyi oynat' :
      repeatingPositionLabel ? 'Kaynak kesitini oynat' : choice.label;
    const card = makeButton(root, label, () => {
      openedDuringPlayback.delete(els); void player.select(choice.id);
    },
      'choice story-choice gameplay-choice gameplay-choice-card');
    card.disabled = false;
    card.dataset.choiceId = choice.id;
    card.dataset.choiceSurface = surface;
    card.setAttribute('aria-pressed', String(state.selection?.choiceId === choice.id));
    // Source timestamps belong in the owner timeline/debug report, not in
    // cinematic choice buttons. Show the action itself, without duration.
  }

  // One selection surface only. The former secondary quick-action dock
  // mirrored the same cards and caused stacked/duplicated controls.
  els.adultQuickChoices?.replaceChildren();

  if (state.selection && open) {
    makeButton(root, state.status === 'paused' ? 'Sürdür' : 'Duraklat',
      () => state.status === 'paused' ? void player.resume() : player.pause(), 'gameplay-playback-control');
    makeButton(root, 'Yeniden oynat', () => { openedDuringPlayback.delete(els); void player.replay(); },
      'gameplay-playback-control');
  }
  if (!state.selection || open) {
    const map = document.createElement('details'); map.className = 'gameplay-event-map';
    const heading = document.createElement('summary'); heading.textContent = 'Olay haritası'; map.appendChild(heading);
    for (const clip of state.graph.clips) {
      const choice = state.graph.choices.find(row => row.clipIds.includes(clip.id));
      if (!choice) continue;
      makeButton(map, choice.label, () => {
        openedDuringPlayback.delete(els); void player.selectSourceEvent(clip.id);
      }, 'gameplay-event-link');
    }
    root.appendChild(map);
  }

  if (state.status === 'error') makeButton(root, 'Yeniden dene', () => void player.retry());
  if (state.error && !state.selection && choices.length)
    makeButton(root, 'Videoya devam et', () => void player.continueVideo());
  if (state.status === 'paused') makeButton(root, 'Oynatmaya devam et', () => void player.resume());
  const remainingStageIds = chapter?.stageIds.slice(chapter.stageIds.indexOf(state.stageId) + 1) || [];
  if (progress.nextStageId && !state.selection)
    makeButton(root, 'Sonraki aşama', () => player.advanceStage());
  else if (!state.selection && !choices.length && remainingStageIds.length)
    makeButton(root, 'Sonraki aşama', () => player.skipStage());
  // An exhausted stage is NOT the end of the chapter if there are still
  // observed intermediate stages; never offer a shortcut over them.
  if (!state.selection && !remainingStageIds.length && (progress.completed || !choices.length)) {
    if (state.chapterId) makeButton(root, 'Sonraki sahne', () => player.nextChapter());
    if (state.cursor < state.graph.duration - .05)
      makeButton(root, 'Videoya devam et', () => void player.continueVideo());
  }
  if (state.selection && progress.phase === 'STORY')
    makeButton(root, 'Sonraki hikâye olayına geç', () => void player.skipCurrentClip(),
      'choice gameplay-skip gameplay-choice-card');
  else if (choices.length && (state.selection || !progress.completed))
    makeButton(root, 'Bu aşamayı geç', () => player.skipStage(),
      'choice gameplay-skip gameplay-choice-card');

  syncInteractionSurfaces({ panel: els.adultInteractionPanel, overlay: els.choices,
    approach: els.approachChoices, surface: state.selection && !open ? 'none' : surface });
  const clip = nextPlayableClip(state);
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
  if (els.movementCount) els.movementCount.textContent = `${visibleChoices.length} seçenek`;
  if (els.movementHeading) els.movementHeading.textContent = positions.length
    ? 'Gözlenen hareketler' : 'Gözlenen eylemler';
  if (els.femaleProgressText) els.femaleProgressText.textContent = `%${Math.round(progress.lust)}`;
  if (els.femaleProgressBar) els.femaleProgressBar.style.width = `${progress.lust}%`;
}
