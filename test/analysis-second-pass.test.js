import test from 'node:test';
import assert from 'node:assert/strict';
import {findSilentGaps,findLongPositionRows,mergeSilentGapActions,refinePositionRow} from '../public/analysis-gap-repair.js';
import {createGameplayGraph} from '../public/gameplay-evidence.js';
import {createGameplayState,gameplayReducer as reduce,progression,availableChoices} from '../public/gameplay-state.js';
import {observation,analysis,evidence} from './fixtures/gameplay-v2.js';

const row=(id,startTime,endTime,extra={})=>({
  actionId:id,startTime,endTime,sourceVerified:true,confidence:.95,...extra
});
test('silent gaps are detected with dense, capped windows and no source facts are invented',()=>{
  const actions=[row('a',86,103),row('b',112,288),row('c',374,453)];
  const gaps=findSilentGaps(actions,460.7);
  assert.deepEqual(gaps.map(g=>[Math.round(g.startTime),Math.round(g.endTime)]),
    [[0,29],[29,57],[57,86],[288,317],[317,345],[345,374]]);
  assert.ok(gaps.every(g=>g.reason==='SILENT_GAP'&&g.endTime-g.startTime<=40));
  assert.deepEqual(findSilentGaps([],0),[]);
});
test('repairs cannot overwrite observations or fill gaps with unverified source',()=>{
  const existing=[row('first',0,10),row('last',50,60)];
  const gap={startTime:10,endTime:50};
  const {actions,added}=mergeSilentGapActions(existing,[{gap,result:{available:true,actions:[
    row('valid',12,30),row('overlap',28,40),row('outside',45,70),
    {...row('uncertain',31,40),sourceVerified:false}
  ]}}]);
  assert.deepEqual(actions.map(r=>r.actionId),['first','valid','last']);
  assert.equal(added,1);
});
const parent=row('parent',391,441,{adultScene:true,positionId:'seated-facing',
  positionLabel:'Source pose',positionOccurrenceId:'occ-1',adultSceneId:'scene-1',
  subjectTrackId:'performer-a',partnerTrackId:'performer-b',choiceSurface:'panel'});
const cut=(id,start,end,key,more={})=>row(id,start,end,{
  adultScene:true,positionId:'seated-facing',choiceSurface:'panel',sourceActionId:key,
  subjectTrackId:'performer-a',partnerTrackId:'performer-b',
  gameplayEvidence:{version:2,sourceActionId:key,occurrenceId:'occ-1',
    action:{verified:true,key,label:key,evidence:'Independent frame evidence',confidence:.95}},
  ...more
});
test('long core event is considered for review, not automatically cut',()=>{
  assert.deepEqual(findLongPositionRows([parent,row('short',0,7,{...parent,actionId:'short',startTime:0,endTime:7})])
    .map(r=>r.actionId),['parent']);
  assert.equal(refinePositionRow([parent],parent,{actions:[cut('a',392,400,'one')]}).replaced,false);
});
test('verified distinct movements replace only parent; repeated cuts are preserved',()=>{
  const source=[parent,row('unrelated',280,310)];
  const children=[cut('m1',392,401,'slow'),cut('m2',404,414,'fast'),
    cut('m3',417,424,'slow'),cut('m4',427,440,'pause')];
  const refined=refinePositionRow(source,parent,{actions:children});
  assert.equal(refined.replaced,true);
  assert.equal(refined.sequences,4);
  assert.equal(refined.actions.filter(r=>r.actionId.startsWith('parent-m')).length,4);
  assert.ok(refined.actions.some(r=>r.actionId==='unrelated'));
  assert.ok(refined.actions.filter(r=>r.actionId.startsWith('parent-m'))
    .every(r=>r.positionOccurrenceId==='occ-1'&&r.positionId==='seated-facing'));
});
test('model labels alone cannot reclassify positions or replace first-pass verified row',()=>{
  for(const changes of [
    {positionId:'on-back'}, {subjectTrackId:'different'},
    {gameplayEvidence:{version:2,action:{verified:false,key:'slow',evidence:'',confidence:0}}},
  ]){
    const r=refinePositionRow([parent],parent,{actions:[
      cut('x',392,400,'slow',changes),cut('y',402,410,'fast',changes)
    ]});
    assert.equal(r.replaced,false);
  }
});
function engage(state,choiceId) {
  let s=reduce(state,{type:'SELECT',choiceId});
  assert.ok(s.selection,'valid choice');
  const id=s.selection.id;
  s=reduce(s,{type:'PLAYING',selectionId:id});
  const clip=s.graph.clips.find(c=>c.id===s.selection.clipIds[0]);
  let t=clip.startTime;
  while(t<clip.startTime+3.5){
    const next=Math.min(clip.startTime+3.5,t+.25);
    s=reduce(s,{type:'PLAYBACK',selectionId:id,time:next,elapsed:next-t,playing:true});t=next;
  }
  return reduce(s,{type:'CLIP_ENDED',selectionId:id,time:clip.endTime});
}
test('single approach click cannot fill Lust, but repeats eventually unlock',()=>{
  const graph=createGameplayGraph(analysis([
    observation('warmup',0,{phase:'APPROACH',duration:9}),
    observation('core',15,{phase:'CORE',duration:9,positionId:'seated-facing'})
  ]));
  let state=createGameplayState(graph);
  const choice=availableChoices(state)[0];
  state=engage(state,choice.id);
  assert.ok(progression(state).lust>0&&progression(state).lust<100);
  for(let i=0;i<3&&progression(state).lust<100;i++){
    state={...state,stageId:graph.stages.find(x=>x.phase==='APPROACH').id};
    state=engage(state,choice.id);
  }
  assert.equal(progression(state).lust,100);
});
test('three distinct observed approach actions earn full Lust without fake playback',()=>{
  const graph=createGameplayGraph(analysis([
    observation('warm1',0,{phase:'APPROACH',duration:9}),
    observation('warm2',10,{phase:'APPROACH',duration:9}),
    observation('warm3',20,{phase:'APPROACH',duration:9}),
    observation('core',32,{phase:'CORE',duration:9,positionId:'seated-facing'})
  ]));
  let state=createGameplayState(graph);
  const warm=graph.choices.filter(x=>x.phase==='APPROACH');
  assert.equal(warm.length,3);
  assert.equal(progression(state).lust,0);
  for(let i=0;i<warm.length;i++) {
    state=engage(state,warm[i].id);
    if(i<2)assert.ok(progression(state).lust<100);
  }
  assert.equal(progression(state).lust,100);
  assert.equal(graph.stages.find(x=>x.id===state.stageId).phase,'CORE');
});
