import test from 'node:test';
import assert from 'node:assert/strict';
import { dialogueLabelItems, applyDialogueLabels } from '../public/dialogue-labels.js';
import { sanitizeLabelItems, acceptedLabels } from '../lib/choice-labels.js';

const utterances = [
  { segmentId: 's1', speakerId: 'w', sourceStart: 8, sourceEnd: 10, sourceText: 'Do you want a massage?' },
  { segmentId: 's2', speakerId: 'm', sourceStart: 40, sourceEnd: 41, sourceText: 'Hmm' }
];

test('only story and opening choices with speech right before them are sent, with the Turkish line', () => {
  const actions = [
    { actionId: 'a', sourceVerified: true, choiceSurface: 'story', startTime: 11, label: 'Onunla konuş' },
    { actionId: 'b', sourceVerified: true, choiceSurface: 'panel', positionId: 'rear', startTime: 11, label: 'x' },
    { actionId: 'c', sourceVerified: true, choiceSurface: 'story', startTime: 41, label: 'Kalk' }
  ];
  const items = dialogueLabelItems(actions, { utterances, turkishBySegment: new Map([['s1', 'Masaj ister misin?']]),
    speakerName: id => (id === 'm' ? 'Sen' : 'Selin') });
  assert.deepEqual(items.map(item => item.actionId), ['a']);
  assert.deepEqual(items[0].lines, [{ speaker: 'Selin', text: 'Do you want a massage?', tr: 'Masaj ister misin?' }]);
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
});
