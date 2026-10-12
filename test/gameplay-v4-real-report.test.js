import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameplayGraph } from '../public/gameplay-evidence.js';
import { createGameplayState, availableChoices, progression } from '../public/gameplay-state.js';
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

test('reported 11 source observations compile into 2 continuous source chapters, not 7 fragments',()=>{
  const graph=createGameplayGraph(source);
  assert.equal(graph.rejected.length,0);
  assert.equal(graph.chapters.length,2);
  assert.equal(graph.clips.length,11);
  assert.equal(graph.choices.length,11);
  assert.equal(graph.clips[0].startTime,7.2);
  assert.equal(graph.clips[0].endTime,86.38);
  assert.equal(graph.clips[0].previewEndTime,86.38);
  assert.ok(graph.clips.every(clip=>clip.previewEndTime===clip.endTime));
  assert.equal(graph.stages.filter(s=>s.phase==='STORY').length,1);
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

test('stage skips and next chapter seek the actual destination time rather than an old cursor',async t=>{
  const graph=createGameplayGraph(source);
  const video=new Media();
  const player=createGameplayPlayer({graph,video,seek:fakeSeek,play:fakePlay});
  t.after(()=>player.destroy());
  player.skipStage();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(player.getState().stageId,graph.stages[1].id);
  assert.equal(video.currentTime,211.158);
  assert.equal(video.seeks.at(-1),211.158);
  player.nextChapter();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(video.currentTime,374.326);
  assert.equal(video.seeks.at(-1),374.326);
  assert.equal(progression(player.getState()).value,0);
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
  assert.equal(player.getState().stageId,graph.stages[0].id);
  assert.equal(progression(player.getState()).value,0);
});
