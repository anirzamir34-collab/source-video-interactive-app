import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameplayGraph } from '../public/gameplay-evidence.js';
import { createGameplayState, availableChoices, activeSurface, progression, gameplayReducer } from '../public/gameplay-state.js';
import { renderGameplay, phaseVisibleChoices } from '../public/gameplay-view.js';
import { createGameplayPlayer } from '../public/gameplay-player.js';

// Distilled from the user's 2026-10-12 real analysis diagnostic, not synthetic
// desired outputs. No media, personal story labels or transcript are embedded.
// The source showed 11 observations with unstable scene/cast aliases.
const observed = [
  ['talk-1',7.2,86.38,'dialogue', '', 'legacy-a'],
  ['talk-2',86.383,103.18,'dialogue','','legacy-b'],
  ['transition',103.18,112.778,'scene_transition','','legacy-c'],
  ['talk-3',112.778,170.366,'dialogue','','legacy-d'],
  ['talk-4',172.766,211.158,'dialogue','','legacy-e'],
  ['approach-1',211.158,227.955,'kiss','','scene-001'],
  ['core-1',227.955,287.943,'position','seated-facing','scene-001'],
  ['core-2',287.943,321.536,'position','seated-facing','adult-scene-001'],
  ['core-3',374.326,388.723,'position','standing','scene-001'],
  ['core-4',391.123,441.513,'position','seated-facing','scene-001'],
  ['aftermath',443.912,453.51,'aftermath','','scene-001']
];
const source = {
  videoDuration: 460.8,
  storyContext: {},
  actions: observed.map(([actionId,startTime,endTime,actionType,positionId,adultSceneId], index) => ({
    actionId,startTime,endTime,actionType,adultSceneId, positionId,
    label:'Gözlenen kaynak olayı '+index, sourceVerified:true,confidence:1,
    ...(positionId ? { adultScene: true, positionLabel: positionId,
      positionConfigurationConfidence: .95, positionEvidence: 'Synthetic source configuration',
      classificationReview: 'verified', choiceSurface:'panel' } : {}),
    subjectTrackId:'track-a',
    partnerTrackId: index === 2 ? '' : 'track-b',
    involvedCharacterIds: index === 2 ? ['track-a'] : ['track-a','track-b'],
    positionOccurrenceId:'occ-'+index,
    // Old source may reuse the same ID for unrelated occurrences.
    gameplayEvidence:{ version:2,sourceActionId: index%4===0 ? 'reused-id' : actionId,
      chapterId: adultSceneId,occurrenceId:'occ-'+index,
      action:{verified:false,confidence:0,evidence:'',label:''},
      provenance:'visual-storyboard' }
  }))
};

class Media extends EventTarget {
  constructor() { super(); this.currentTime=0; this.paused=true; this.seeking=false;
    this.playbackRate=1; this.readyState=4; this.duration=460.8;this.seeks=[]; }
  pause() {this.paused=true;}
}
const fakeSeek = async (video,time) => {video.seeks.push(time);video.currentTime=time;};
const fakePlay = async video => {video.paused=false;};

test('reported observations keep two chapters and separate chronological story stops',()=>{
  const graph=createGameplayGraph(source);
  assert.equal(graph.rejected.length,0);
  assert.equal(graph.chapters.length,2);
  assert.equal(graph.clips.length,11);
  assert.equal(graph.choices.length,11);
  assert.equal(graph.clips[0].startTime,7.2);
  assert.equal(graph.clips[0].endTime,86.38);
  assert.equal(graph.clips[0].previewEndTime,86.38);
  assert.ok(graph.clips.every(clip=>clip.previewEndTime===clip.endTime));
  assert.equal(graph.stages.filter(s=>s.phase==='STORY').length,5);
  assert.equal(graph.stages.filter(s=>s.phase==='CORE').length,2);
  assert.ok(graph.choices.every(c=>c.clipIds.length===1),'reused IDs never merge unrelated actions');
});

test('one narrative start plays all five chronological observations without five button prompts',async t=>{
  const graph=createGameplayGraph(source);
  const video=new Media();let time=0;
  const player=createGameplayPlayer({graph,video,seek:fakeSeek,play:fakePlay,now:()=>time*1000});
  t.after(()=>player.destroy());
  assert.equal(availableChoices(player.getState()).length,1);
  await player.select(availableChoices(player.getState())[0].id);
  for(let i=0;i<5;i++){
    const current=player.getState().selection;
    assert.ok(current, 'narrative selection must advance automatically');
    const clip=graph.clips.find(c=>c.id===current.clipIds[current.index]);
    time+=clip.endTime-video.currentTime;
    video.currentTime=clip.endTime;
    await player.sample();
    if(i<4)assert.ok(player.getState().selection,'continuous dialogue is not another decision screen');
  }
  assert.equal(player.getState().selection,null);
  assert.equal(player.getState().graph.stages.find(s=>s.id===player.getState().stageId).phase,'APPROACH');
  assert.equal(progression(player.getState()).value,0);
});

test('stage navigation preserves intermediate actions and bridges an unanalysed chapter gap', async t => {
  const graph = createGameplayGraph(source);
  const video = new Media();
  const player = createGameplayPlayer({ graph, video, seek: fakeSeek, play: fakePlay });
  t.after(() => player.destroy());

  for (let i = 0; i < 5; i++) {
    player.skipStage();
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(player.getState().stageId, graph.stages[5].id);
  assert.equal(video.currentTime, 211.158);

  await player.nextChapter();
  assert.equal(player.getState().stageId, graph.stages[5].id,
    'nextChapter must not bypass the remaining core stage');

  player.skipStage();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(player.getState().stageId, graph.stages[6].id);

  player.skipStage();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(player.getState().status, 'continuing');
  assert.equal(player.getState().chapterId, graph.chapters[0].id);
  assert.equal(video.currentTime, graph.chapters[0].endTime,
    'the unknown gap must play from the final observed source boundary');
  assert.equal(video.seeks.at(-1), graph.chapters[0].endTime);
  assert.equal(progression(player.getState()).value, 0,
    'source-only playback never awards progress');

  video.currentTime = graph.chapters[1].startTime + 0.31;
  await player.sample();
  assert.equal(video.currentTime, graph.chapters[1].startTime,
    'arrival must seek back to the exact verified event boundary');
  assert.equal(player.getState().chapterId, graph.chapters[1].id);
  assert.equal(player.getState().status, 'decision');
  assert.equal(progression(player.getState()).value, 0);
});

test('selected source footage cannot be completed before its verified end',()=>{
  const graph=createGameplayGraph(source);
  const first=graph.clips[0];
  assert.equal(first.endTime,86.38);
  assert.ok(first.endTime-first.startTime>70);
  assert.notEqual(first.previewEndTime,first.startTime+12);
  const state=createGameplayState(graph);
  assert.equal(state.stageId,graph.stages[0].id);
  assert.equal(state.cursor,0);
});

test('skipping the current long story observation keeps later story events playable', async t=>{
  const graph=createGameplayGraph(source);
  const video=new Media();const player=createGameplayPlayer({graph,video,seek:fakeSeek,play:fakePlay});
  t.after(()=>player.destroy());
  await player.select(availableChoices(player.getState())[0].id);
  assert.equal(video.currentTime,7.2);
  await player.skipCurrentClip();
  assert.equal(video.currentTime,86.383);
  assert.equal(player.getState().selection?.choiceId,graph.choices[1].id);
  assert.equal(player.getState().stageId,graph.stages[1].id);
  assert.equal(progression(player.getState()).value,0);
});


test('timeline arrows step through actual source events rather than jumping chapters',async t=>{
  const graph=createGameplayGraph(source);
  const video=new Media();
  const player=createGameplayPlayer({graph,video,seek:fakeSeek,play:fakePlay});
  t.after(()=>player.destroy());
  player.stepSourceEvent(1);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(video.currentTime,7.2);
  player.stepSourceEvent(1);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(video.currentTime,86.383);
  assert.equal(player.getState().chapterId,graph.chapters[0].id);
  player.stepSourceEvent(1);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(video.currentTime,103.18);
  player.stepSourceEvent(-1);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(video.currentTime,86.383);
  assert.ok(!video.seeks.includes(374.326), 'arrows must not skip to a later chapter');
});


test('cinematic story exposes locally grouped sourced cards throughout playback',()=>{
  const labelled={...source,actions:source.actions.map((a,index)=>({
    ...a,label:index<5 ? 'Kaynak olayı '+(index+1) : a.label,
    ...(index<5 ? {storyEvidenceLevel:'fact',storyConfidence:.95,
      narrativeChoiceLabel:'Kaynak olayı '+(index+1)} : {})
  }))};
  const graph=createGameplayGraph(labelled);
  const makeElement=tag=>({
    tag,children:[],attributes:{},dataset:{},style:{},textContent:'',
    classList:{add(){},remove(){},toggle(){}},
    appendChild(child){this.children.push(child);child.parentElement=this;return child;},
    replaceChildren(...children){this.children=children;},
    setAttribute(key,value){this.attributes[key]=String(value);},
    addEventListener(){},
  });
  const document={createElement:makeElement,querySelectorAll:()=>[]};
  const stage=makeElement('stage');stage.ownerDocument=document;
  const video={closest:()=>stage};
  const els={video,adultInteractionPanel:makeElement('panel'),
    choices:makeElement('choices'),approachChoices:makeElement('approach'),
    movementChoices:makeElement('movement'),positionTabs:makeElement('tabs')};
  const player={select(){},advanceStage(){},skipStage(){},nextChapter(){},
    continueVideo(){},skipCurrentClip(){}};
  let state=createGameplayState(graph);
  assert.equal(availableChoices(state).length,1);
  renderGameplay({state,player,els,document});
  const labels=()=>els.choices.children.filter(row=>row.tag==='button').map(row=>row.textContent);
  assert.equal(labels().filter(text=>text.startsWith('Kaynak olayı')).length,4);
  assert.ok(!labels().includes('Sonraki sahne'));
  assert.ok(!els.choices.children.some(row=>row.className==='gameplay-source-meta'));

  state=gameplayReducer(state,{type:'SELECT',choiceId:graph.choices[0].id});
  renderGameplay({state,player,els,document});
  assert.equal(labels().filter(text=>text.startsWith('Kaynak olayı')).length,4,
    'source playback must keep the same four local decisions visible');
  assert.ok(!labels().includes('Duraklat') && !labels().includes('Yeniden oynat'),
    'playback commands must not be mixed into story choices');

  state=gameplayReducer(state,{type:'SEEK',time:211.2});
  renderGameplay({state,player,els,document});
  assert.ok(els.approachChoices.children.some(row=>row.tag==='button'));
  assert.ok(!labels().includes('Sonraki sahne'),
    'an empty story stage cannot bypass the later stages in its chapter');
});

test('after-scene choices use the narrative overlay without moving or rewriting verified source ranges', () => {
  const graph = createGameplayGraph(source);
  const after = graph.stages.find(row => row.phase === 'AFTERMATH');
  assert.ok(after, 'the observed aftermath remains a distinct chronological stage');
  assert.equal(after.surface, 'panel', 'existing graph and saved-game fingerprint stay unchanged');

  const state = gameplayReducer(createGameplayState(graph), { type: 'SEEK', time: 444 });
  assert.equal(state.stageId, after.id);
  assert.equal(activeSurface(state), 'story', 'runtime surface owns the correct overlay');
  assert.ok(availableChoices(state).length, 'the after-scene selection remains playable');
  assert.equal(graph.clips.at(-1).startTime, 443.912);

  const makeElement = name => {
    const classes = new Set();
    return { name, children: [], dataset: {}, style: {}, classList: {
      add(cls) { classes.add(cls); }, remove(cls) { classes.delete(cls); },
      contains(cls) { return classes.has(cls); },
      toggle(cls, force) { if (force === undefined ? !classes.has(cls) : force) classes.add(cls); else classes.delete(cls); },
    }, appendChild(child) { this.children.push(child); child.parentElement = this; return child; },
    replaceChildren(...children) { this.children = children; },
    setAttribute() {}, addEventListener() {},
    };
  };
  const document = { createElement: makeElement, querySelectorAll: () => [] };
  const stage = makeElement('stage'); stage.ownerDocument = document;
  const els = { video: { closest: () => stage }, adultInteractionPanel: makeElement('panel'),
    choices: makeElement('story'), approachChoices: makeElement('approach'),
    movementChoices: makeElement('movements'), positionTabs: makeElement('tabs') };
  renderGameplay({ state, els, document, player: { select() {}, nextChapter() {}, continueVideo() {} } });
  assert.equal(els.choices.classList.contains('hidden'), false);
  assert.equal(els.adultInteractionPanel.classList.contains('hidden'), true);
  assert.equal(els.approachChoices.classList.contains('hidden'), true);
  assert.ok(els.choices.children.some(row => row.textContent === 'Sahne sonrası · Seçimler'));
  assert.ok(!els.choices.children.some(row => String(row.textContent || '').includes('Lust %')));
});

test('13-action real report topology exposes four opening story cards and both distinct core choices', () => {
  // The report records 13 verified source actions, split into two chapters.
  // This small topology retains their source bounds and categories, without
  // storing the video, transcript or sensitive scene descriptions.
  const events = [
    [0,14.4,'story'],[14.4,40.8,'story'],[40.8,86.383,'story'],
    [86.383,103.18,'dialogue'],[112.778,172.766,'dialogue'],
    [134.373,136.773,'touch'],[172.766,211.158,'dialogue'],
    [211.158,227.955,'position','rear'],[227.955,287.943,'position','missionary'],
    [325.376,327.53,'body_transition'],[374.326,388.723,'touch'],
    [391.123,431.915,'position','rear'],[441.513,451.111,'position','missionary']
  ];
  const actions = events.map(([startTime,endTime,actionType,positionId],index) => ({
    actionId: 'event-'+index, sourceActionId:'source-'+index, startTime,endTime,actionType,
    sourceVerified:true, confidence: .99, positionId:positionId || '',
    positionLabel:positionId || '', classificationReview: 'verified',
    positionConfigurationConfidence:positionId ? .99 : 0,
    positionEvidence:positionId ? 'Verified by source frame' : '',
    choiceSurface:positionId ? 'panel' : actionType === 'touch' ? 'approach' : 'story',
    label:'Source choice '+index, subjectTrackId:'person-1', partnerTrackId:'person-2'
  }));
  const graph = createGameplayGraph({videoDuration:460.8,actions});
  assert.equal(graph.choices.length,13);
  const story = createGameplayState(graph);
  assert.equal(phaseVisibleChoices(story).length,4, 'opening narrative buttons must not be serialized as only one');
  const coreStage = graph.stages.find(row=>row.phase==='CORE');
  assert.ok(coreStage);
  const core = { ...story, stageId:coreStage.id,chapterId:coreStage.chapterId };
  assert.equal(phaseVisibleChoices(core).length,2, 'two verified position families must remain selectable');
  assert.deepEqual(phaseVisibleChoices(core).map(row=>row.positionId),['rear','missionary']);
});
