import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanDisplayLabel, cleanPanelDisplayLabels } from '../public/display-labels.js';

test('tracking labels are removed from all levels of visible choice copy', () => {
  assert.equal(cleanDisplayLabel('Manzaraya bak · Karakter A · Sekans 2'), 'Manzaraya bak · Sekans 2');
  assert.equal(cleanDisplayLabel('Orman yolu · Partner B'), 'Orman yolu');
  for (const label of ['Karakter A', 'Karakter B', 'Karakter A/B', 'PARTNER_A', 'CHARACTER_2',
    'İntim karakter', 'intim karakter', 'Intimate character', 'Ana karakter', 'MAIN_MALE']) {
    assert.equal(cleanDisplayLabel(label), '');
  }
});

test('references inside sentences retain their case without inventing a name or relationship', () => {
  const cases = [
    ["Partner A'yı dinle", 'Onu dinle'],
    ['Karakter B ile konuşmaya devam et', 'Onunla konuşmaya devam et'],
    ["Partner A'nın yanıtını dinle", 'Onun yanıtını dinle'],
    ["Karakter B’ye sor", 'Ona sor'],
    ["Önce Partner A'dan yanıt al", 'Önce ondan yanıt al'],
    ['İntim karakter ile konuş', 'Onunla konuş'],
    ['Karakter A gülümsüyor', 'O gülümsüyor']
  ];
  for (const [input, expected] of cases) assert.equal(cleanDisplayLabel(input), expected);
});

test('real names, non-identity descriptions and timing are preserved', () => {
  for (const label of ['Meral ile konuş', 'Partner Aysun', 'Karakter analizi', 'Araba kullan',
    '3. kesit · 01:20 – 01:35', 'Danny ile ilişkisi: sevgilisi']) {
    assert.equal(cleanDisplayLabel(label), label);
  }
});

test('visible cleanup changes text and accessibility copy, never IDs or button identity', () => {
  const nodes = [{ data: "Partner A'yı dinle" }, { data: ' · Karakter A' }, { data: '  ' }];
  const attrs = new Map([['aria-label', 'Dinle · Karakter A'], ['title', 'Karakter A']]);
  const button = {
    dataset: { clipId: 'PARTNER_A:clip-3', variantIds: 'a,b,c' },
    onclick: () => 'existing-handler',
    getAttribute: name => attrs.get(name) ?? null,
    setAttribute: (name, value) => attrs.set(name, value),
    removeAttribute: name => attrs.delete(name)
  };
  const callback = button.onclick;
  const root = { ownerDocument: { createTreeWalker: () => {
    let index = 0; return { nextNode: () => nodes[index++] };
  } }, querySelectorAll: () => [button] };
  cleanPanelDisplayLabels(root);
  cleanPanelDisplayLabels(root); // Re-renders and observer callbacks are idempotent.
  assert.deepEqual(nodes.map(node => node.data), ['Onu dinle', '', '  ']);
  assert.equal(attrs.get('aria-label'), 'Dinle');
  assert.equal(attrs.has('title'), false);
  assert.deepEqual(button.dataset, { clipId: 'PARTNER_A:clip-3', variantIds: 'a,b,c' });
  assert.equal(button.onclick, callback);
});
