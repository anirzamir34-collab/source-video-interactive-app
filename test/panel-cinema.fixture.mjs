// Neutral visual fixture; no provider calls or production state.
// node test/panel-cinema.fixture.mjs prints self-contained HTML for a browser.
import fs from 'node:fs/promises';
const root = new URL('../public/', import.meta.url);
const source = await fs.readFile(new URL('index.html', root), 'utf8');
const css = (await Promise.all(['styles.css', 'player-controls.css', 'panel-cinema.css']
  .map(name => fs.readFile(new URL(name, root), 'utf8')))).join('\n');
const feedback = (await fs.readFile(new URL('panel-feedback.js', root), 'utf8')).replaceAll('export function', 'function');
function setup() {
  document.querySelectorAll('main > :not(#playerSection)').forEach(el => el.remove());
  document.querySelector('#playerSection').classList.remove('hidden');
  const stage = document.querySelector('.video-stage');
  stage.classList.add('fixture-fullscreen');
  const panel = document.querySelector('#adultInteractionPanel');
  panel.classList.remove('hidden'); panel.classList.add('compact-expanded');
  for (const id of ['discoveryGate', 'foreplaySection', 'categorySection', 'orgasmDecision', 'outcomeSection']) {
    document.getElementById(id).classList.add('hidden');
  }
  for (const id of ['positionSection', 'movementSection', 'rhythmControl']) {
    document.getElementById(id).classList.remove('hidden');
  }
  document.getElementById('adultDockTitle').textContent = 'Orman yürüyüşü';
  document.getElementById('movementHeading').textContent = 'Bu bölümde';
  document.getElementById('movementCount').textContent = '6 kesit · 3 seçenek';
  document.getElementById('positionTabs').innerHTML = ['Orman yolu', 'Nehir kıyısı', 'Kamp alanı'].map((label, i) =>
    `<button type="button" class="position-tab ${i ? '' : 'active'}">${label}</button>`).join('');
  document.getElementById('movementChoices').innerHTML = ['Patikayı takip et', 'Manzaraya bak', 'Yürüyüşe devam et'].map((label, i) =>
    `<div class="movement-choice-wrap"><button type="button" class="movement-choice-card" data-variant-ids="clip-${i}"><span>${label}</span><small class="movement-variant-status">2 doğrulanmış kesit</small></button></div>`).join('');
  document.getElementById('rhythmTapLabel').textContent = 'DEVAM ET';
  document.getElementById('rhythmTapStatus').textContent = '4 kesit hazır · sonraki 0:20';
  document.getElementById('clipNavigatorSummary').textContent = '4 kesiti gör';
  document.getElementById('clipNavigator').classList.remove('hidden');
  document.getElementById('clipNavigatorList').innerHTML = ['0:20 – 0:30', '0:30 – 0:40', '0:40 – 0:50', '0:50 – 1:00'].map((t, i) =>
    `<button class="clip-navigator-choice">${i + 1}. kesit · ${t}</button>`).join('');
  document.getElementById('choices').classList.add('hidden');
  const video = document.getElementById('video');
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="#182a33"/><path d="M0 720L400 280L690 520L930 190L1280 650V720" fill="#385c5c"/><circle cx="240" cy="180" r="70" fill="#cfb785"/><g fill="#e8f6f0" font-family="sans-serif" font-size="32"><text x="24" y="48">1</text><text x="1220" y="48">2</text><text x="24" y="695">3</text><text x="1220" y="695">4</text><text x="410" y="140">SOURCE FRAME · 16:9</text></g></svg>';
  video.poster = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  const media = { currentTime: 15, paused: false, seeking: false };
  const snapshot = { scope: 'scene-a', clip: { id: 'clip-0', startTime: 10, endTime: 20 } };
  for (const key of ['currentTime', 'paused', 'seeking']) Object.defineProperty(video, key, { get: () => media[key] });
  attachPanelFeedback({ stage, panel, video, choices: document.getElementById('choices'), getSnapshot: () => snapshot });
  document.getElementById('fullscreenBtn').onclick = () => stage.requestFullscreen();
  document.getElementById('adultDockMoreBtn').onclick = () => {
    panel.classList.toggle('compact-expanded'); panel.classList.toggle('compact-collapsed');
  };
  const test = document.createElement('button');
  test.textContent = 'Durum testi'; test.id = 'fixtureStateTest';
  test.style.cssText = 'position:absolute;top:10px;left:200px;z-index:9999';
  stage.append(test);
  test.onclick = () => {
    media.seeking = !media.seeking;
    video.dispatchEvent(new Event(media.seeking ? 'seeking' : 'seeked'));
  };
}
const base = source.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<link[^>]*>/g, '')
  .replace('</head>', `<style>${css.replaceAll(':fullscreen', '.fixture-fullscreen').replaceAll(':-webkit-full-screen', '.fixture-fullscreen')}\n.fixture-fullscreen { position:fixed!important; inset:0!important; width:100vw!important; height:100vh!important; margin:0!important; border-radius:0!important; }</style></head>`)
  .replace('</body>', `<script>${feedback}\n(${setup.toString()})();</script></body>`);
const escaped = base.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
process.stdout.write(`<!doctype html><html><head><meta charset="utf-8"><title>Panel layout QA</title></head><body style="background:#10191e;color:white;font:16px sans-serif">
<h1>Neutral panel layout QA</h1><p>Actual production CSS; fullscreen selectors mirrored within fixed-size frames.</p>
${[[844,390],[390,844],[1280,720]].map(([w,h]) => `<h2>${w} × ${h}</h2><iframe title="${w}x${h}" width="${w}" height="${h}" allow="fullscreen" srcdoc="${escaped}"></iframe>`).join('')}
</body></html>`);
