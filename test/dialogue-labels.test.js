import test from 'node:test';
import assert from 'node:assert/strict';
import { dialogueLabelItems, applyDialogueLabels } from '../public/dialogue-labels.js';
import { sanitizeLabelItems, acceptedLabels } from '../lib/choice-labels.js';

const utterances = [
  { segmentId: 's1', speakerId: 'w', sourceStart: 8, sourceEnd: 10, sourceText: 'Do you want a massage?' },
  { segmentId: 's2', speakerId: 'm', sourceStart: 40, sourceEnd: 41, sourceText: 'Hmm' }
];

test('every label is sent for a perspective check; only story lines carry the speech before them', () => {
  const actions = [
    { actionId: 'a', sourceVerified: true, choiceSurface: 'story', startTime: 11, label: 'Onunla konuş' },
    { actionId: 'b', sourceVerified: true, choiceSurface: 'panel', positionId: 'rear', startTime: 11, label: 'x' },
    { actionId: 'c', sourceVerified: true, choiceSurface: 'story', startTime: 41, label: 'Kalk' }
  ];
  const items = dialogueLabelItems(actions, { utterances, turkishBySegment: new Map([['s1', 'Masaj ister misin?']]),
    speakerName: id => (id === 'm' ? 'Sen' : 'Selin') });
  assert.deepEqual(items.map(item => item.actionId), ['a', 'b', 'c'], 'every label is checked for perspective');
  assert.deepEqual(items[0].lines, [{ speaker: 'Selin', text: 'Do you want a massage?', tr: 'Masaj ister misin?' }]);
  assert.deepEqual(items[1].lines, [], 'sex-panel labels never use dialogue');
  assert.equal(items[1].surface, 'panel');
  assert.deepEqual(items[2].lines, [], 'a lone "Hmm" is not dialogue');
});

test('answers are filtered: family roles, kız, ids and unchanged labels are refused', () => {
  const items = sanitizeLabelItems([{ actionId: 'a', currentLabel: 'Onunla konuş', lines: [{ speaker: 'Selin', text: 'x' }] },
    { actionId: 'b', currentLabel: 'Kapıyı aç', lines: [{ text: 'y' }] }, { actionId: 'c', currentLabel: 'Otur', lines: [{ text: 'z' }] },
    { actionId: 'd', currentLabel: 'Bak', lines: [{ text: 'w' }] }]);
  const out = acceptedLabels({ labels: [
    { actionId: 'a', keep: false, label: 'Masaj teklifini kabul et.' },
    { actionId: 'b', keep: false, label: 'Üvey annene kapıyı aç' },
    { actionId: 'c', keep: false, label: 'Kızın yanına otur' },
    { actionId: 'd', keep: false, label: 'PARTNER_A ile konuş' },
    { actionId: 'zzz', keep: false, label: 'Uydurma' }] }, items);
  assert.deepEqual(out, { a: 'Masaj teklifini kabul et' });
});

test('an accepted label becomes the story wording and the old one is kept', () => {
  const actions = [{ actionId: 'a', label: 'Onunla konuş', narrativeChoiceLabel: '' }, { actionId: 'b', label: 'Otur' }];
  assert.equal(applyDialogueLabels(actions, { a: 'Masaj teklifini kabul et' }), 1);
  assert.equal(actions[0].narrativeChoiceLabel, 'Masaj teklifini kabul et');
  assert.equal(actions[0].labelBeforeDialogue, 'Onunla konuş');
  assert.equal(actions[0].storyEvidenceLevel, 'fact');
  assert.equal(actions[1].narrativeChoiceLabel, undefined);
  assert.equal(dialogueLabelItems(actions, { utterances }).length, 0, 'done once');
  const panel = [{ actionId: 'p', positionId: 'rear', label: 'Penisinin ucunu yalamasına izin ver' }];
  applyDialogueLabels(panel, { p: 'Penisini yalamasına izin ver' });
  assert.equal(panel[0].label, 'Penisini yalamasına izin ver', 'a panel card shows its corrected label');
});

test('the story summary keeps one name per person and refuses family roles', async () => {
  const { sanitizeSummaryInput, acceptedSummary } = await import('../lib/story-summary.js');
  const input = sanitizeSummaryInput({ chapters: [{ startTime: 0, endTime: 60, text: 'Mercedes odaya girer.' }],
    cast: [{ name: 'Mercedes', identity: 'trans kadın' }] });
  const ok = acceptedSummary({ title: 'Profesörün odası', summary: 'Mercedes odaya girer ve adamla konuşur, sonra yanına oturur.',
    beats: [{ startTime: 5, text: 'Mercedes odaya girer.' }, { startTime: 999, text: 'Sonra' }] }, input);
  assert.equal(ok.beats[0].startTime, 5);
  assert.equal(ok.beats[1].startTime, null, 'a time outside the video is dropped');
  assert.equal(acceptedSummary({ title: 'x', summary: 'Mercedes üvey annesiyle konuşur ve odadan çıkar, sonra geri döner.', beats: [] }, input), null);
});
