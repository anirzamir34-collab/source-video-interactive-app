import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../public/panel-cinema.css', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('landscape approach stays beside the video and scrolls inside a transparent compact surface', () => {
  assert.match(css, /orientation:\s*landscape[\s\S]*?#approachChoices:not\(\.hidden\)[\s\S]*?left:\s*max\(/);
  assert.match(css, /#approachChoices:not\(\.hidden\)[\s\S]*?overflow-y:\s*auto/);
  assert.match(css, /#approachChoices:not\(\.hidden\)[\s\S]*?background:\s*transparent\s*!important/);
});

test('visible choice text is limited to two lines while full source copy stays accessible', () => {
  assert.match(css, /\[data-choice-label\][\s\S]*?-webkit-line-clamp:\s*2/);
  assert.match(app, /className = 'choice-detail'/);
  assert.match(app, /button\.setAttribute\('aria-label', choice\.label\)/);
});
