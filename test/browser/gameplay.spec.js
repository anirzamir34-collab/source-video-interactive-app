import { test, expect } from '@playwright/test';
import { observation, evidence } from '../fixtures/gameplay-v2.js';
const source = actions => ({ videoDuration: 24, playStartTime: 0, storyContext: {}, actions });
const load = async (page, actions) => {
  await page.goto('/');
  await page.waitForFunction(() => !!globalThis.__gameplayTest);
  await page.evaluate(data => __gameplayTest.load(data), source(actions));
};

test('A/G: chronological narrative cards stay local and fullscreen preserves the current choice', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await load(page, Array.from({ length: 7 }, (_, i) => observation(`story-${i}`, i * 3, {
    phase: 'STORY', duration: 2, storyEvidenceLevel: 'fact', storyConfidence: .95,
    narrativeChoiceLabel: `Gözlenen karar ${i}` })));
  await expect(page.locator('#choices .gameplay-choice')).toHaveCount(1);
  await expect(page.getByText('Olay haritası')).toHaveCount(0);
  await expect(page.locator('#choices')).toBeVisible();
  await expect(page.locator('#approachChoices')).toBeHidden();
  await page.evaluate(() => { document.querySelector('.video-stage').requestFullscreen = () => Promise.reject(new Error('fixture denial')); });
  await page.locator('#fullscreenBtn').click();
  await expect(page.locator('#fullscreenStatus')).toContainText('Tam ekran açılamadı');
  await expect(page.locator('#choices .gameplay-choice')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(errors).toEqual([]);
});

test('player owns the clock: switch and navigate before a long clip finishes', async ({ page }, testInfo) => {
  await load(page, [observation('first', 0, { duration: 9 }),
    observation('second', 12, { duration: 9 })]);
  await page.locator('#approachChoices .gameplay-choice').first().click();
  await expect(page.locator('.gameplay-menu-toggle')).toBeVisible();
  await expect(page.locator('#approachChoices')).toBeHidden();
  await page.locator('.gameplay-menu-toggle').click();
  await expect(page.locator('#approachChoices .gameplay-choice')).toHaveCount(2);
  await page.locator('#approachChoices .gameplay-choice').nth(1).click();
  await expect.poll(() => page.locator('#video').evaluate(video => video.currentTime)).toBeGreaterThan(12);
  expect(await page.evaluate(() => __gameplayTest.state().selection?.choiceId)).toContain('second');
  await expect(page.locator('#approachChoices')).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('playing-collapsed.png') });
  await page.locator('.gameplay-menu-toggle').click();
  await page.getByRole('button', { name: 'Duraklat', exact: true }).click();
  await expect(page.locator('#video')).toHaveJSProperty('paused', true);
  await page.getByRole('button', { name: 'Yeniden oynat', exact: true }).click();
  await expect.poll(() => page.locator('#video').evaluate(video => video.currentTime)).toBeLessThan(15);
});

test('phase panels show only local choices and never a global event map', async ({ page }) => {
  await load(page, [observation('dialogue', 0, { phase: 'STORY', duration: 2,
    storyEvidenceLevel: 'fact', storyConfidence: .95, narrativeChoiceLabel: 'Kaynak konuşması' }),
    observation('approach', 3, { duration: 2 }),
    observation('core', 6, { phase: 'CORE', duration: 2,
      positionId: 'seated-facing', positionLabel: 'Kaynak duruşu' })]);
  await expect(page.locator('#choices .gameplay-choice')).toHaveCount(1);
  await expect(page.locator('#choices .gameplay-event-map')).toHaveCount(0);
  await expect(page.locator('.video-stage > .gameplay-event-map')).toHaveCount(0);
  await page.getByRole('button', { name: 'Bu aşamayı geç', exact: true }).click();
  await expect(page.locator('#approachChoices .gameplay-choice')).toHaveCount(1);
  await expect(page.locator('#choices')).toBeHidden();
  await expect(page.locator('#adultInteractionPanel')).toBeHidden();
});

test('two watched opening actions fill Lust and reveal the first position without skipping source video', async ({ page }) => {
  await load(page, [observation('opening-a', 0, { duration: 2 }),
    observation('opening-b', 3, { duration: 2 }),
    observation('position', 9, { phase: 'CORE', duration: 3, positionId: 'seated-facing' })]);
  await page.locator('#approachChoices .gameplay-choice').first().click();
  await expect.poll(() => page.evaluate(() => __gameplayTest.state().selection)).toBeNull();
  await expect(page.locator('#approachChoices')).toBeVisible();
  await page.locator('#approachChoices .gameplay-choice').nth(1).click();
  await expect.poll(() => page.evaluate(() => __gameplayTest.state().stageId)).toContain('position');
  await expect(page.locator('#adultInteractionPanel')).toBeVisible();
  await expect(page.locator('#adultFlowStatus')).toContainText('Lust %100');
  expect(await page.locator('#video').evaluate(video => video.currentTime)).toBeLessThan(9);
  await page.locator('#movementChoices .gameplay-choice').click();
  await expect.poll(() => page.locator('#video').evaluate(video => video.currentTime)).toBeGreaterThan(9);
});

test('B/F/G: real video playback earns bounded engagement and seeks to next stage source start', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await load(page, [observation('a', 0, { duration: 2 }), observation('b', 3, { duration: 2 }),
    observation('ending', 6, { duration: 2, phase: 'CORE' })]);
  await expect(page.locator('#approachChoices .gameplay-choice')).toHaveCount(2);
  await page.locator('#approachChoices .gameplay-choice').first().click();
  await expect.poll(() => page.evaluate(() => __gameplayTest.state().selection)).toBeNull();
  expect(await page.evaluate(() => Object.values(__gameplayTest.state().stageProgress)[0].score)).toBe(50);
  await page.locator('#approachChoices .gameplay-choice').nth(1).click();
  await expect.poll(() => page.evaluate(() => __gameplayTest.state().stageId)).toContain('ending');
  await expect(page.locator('#adultInteractionPanel')).toBeVisible();
  await expect(page.locator('#movementChoices .gameplay-choice')).toBeVisible();
  await expect(page.locator('#adultPhaseTitle')).toHaveText('Etkileşim');
  await expect(page.locator('#approachChoices')).toBeHidden();
  expect(await page.locator('#video').evaluate(video => video.currentTime)).toBeLessThan(6);
  await page.locator('#movementChoices .gameplay-choice').click();
  await expect.poll(() => page.locator('#video').evaluate(video => video.currentTime)).toBeGreaterThan(6);
  expect(errors).toEqual([]);
});

test('D/H: ordered cuts and saved-state restore retain the same earned progress', async ({ page }) => {
  await load(page, [observation('a', 0, { duration: 2, gameplayEvidence: evidence('same') }),
    observation('b', 4, { duration: 2, gameplayEvidence: evidence('same') })]);
  await expect(page.locator('#approachChoices .gameplay-choice')).toHaveCount(1);
  await page.locator('#approachChoices .gameplay-choice').click();
  await expect.poll(() => page.locator('#video').evaluate(video => video.currentTime)).toBeGreaterThan(4);
  await expect.poll(() => page.evaluate(() => __gameplayTest.state().selection)).toBeNull();
  const snapshot = await page.evaluate(() => __gameplayTest.saveAndLoad());
  await page.evaluate(value => __gameplayTest.restore(value), snapshot);
  expect(await page.evaluate(() => __gameplayTest.state().stageProgress)).toEqual(snapshot.stageProgress);
  expect(await page.locator('#video').evaluate(video => video.paused)).toBe(true);
});

test('G: rejected browser play keeps actionable retry and rotating mobile viewport keeps one surface', async ({ page }) => {
  await load(page, [observation('a', 0, { duration: 2 }), observation('b', 3, { duration: 2 })]);
  await page.locator('#video').evaluate(video => {
    const original = video.play.bind(video); let reject = true;
    video.play = () => { if (reject) { reject = false; return Promise.reject(new Error('fixture autoplay rejection')); } return original(); };
  });
  await page.locator('#approachChoices .gameplay-choice').first().click();
  await expect(page.getByRole('button', { name: 'Yeniden dene', exact: true })).toBeVisible();
  expect(await page.evaluate(() => Object.keys(__gameplayTest.state().stageProgress).length)).toBe(0);
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.locator('#approachChoices')).toBeVisible();
  await expect(page.locator('#choices')).toBeHidden();
  await expect(page.locator('#adultInteractionPanel')).toBeHidden();
  await page.getByRole('button', { name: 'Yeniden dene', exact: true }).click();
  await expect.poll(() => page.locator('#video').evaluate(video => video.currentTime)).toBeGreaterThan(.3);
});

test('v4: skip transitions synchronize the media clock and show a single compact panel', async ({ page }) => {
  const errors=[]; page.on('pageerror', e=>errors.push(e.message));
  await load(page,[
    observation('story',0,{phase:'STORY',duration:2,storyEvidenceLevel:'fact',
      storyConfidence:.95,narrativeChoiceLabel:'Kaynakta görülen başlangıç'}),
    observation('approach',3,{phase:'APPROACH',duration:2}),
    observation('core',6,{phase:'CORE',duration:2,positionId:'seated-facing',positionLabel:'Kaynak duruşu'})
  ]);
  await expect(page.getByRole('button',{name:'Bu aşamayı geç',exact:true})).toBeVisible({timeout:3000});
  await page.getByRole('button',{name:'Bu aşamayı geç',exact:true}).click();
  await expect(page.locator('#approachChoices')).toBeVisible();
  await expect.poll(()=>page.locator('#video').evaluate(v=>v.currentTime)).toBeGreaterThan(2.95);
  await page.getByRole('button',{name:'Bu aşamayı geç',exact:true}).click();
  await expect(page.locator('#adultInteractionPanel')).toBeVisible();
  await expect.poll(()=>page.locator('#video').evaluate(v=>v.currentTime)).toBeGreaterThan(5.95);
  await expect(page.locator('#adultQuickChoices button')).toHaveCount(0);
  const geometry=await page.evaluate(()=>{
    const p=document.querySelector('#adultInteractionPanel').getBoundingClientRect();
    const v=document.querySelector('.video-stage').getBoundingClientRect();
    return {panelWidth:p.width,stageWidth:v.width,panelHeight:p.height,stageHeight:v.height,
      portrait:innerHeight>innerWidth};
  });
  if (geometry.portrait) {
    // Portrait uses a shallow bottom sheet: width alone is not the obstruction metric.
    expect(geometry.panelWidth).toBeLessThan(geometry.stageWidth*1.02);
    expect(geometry.panelHeight).toBeLessThan(geometry.stageHeight*.52);
  } else {
    expect(geometry.panelWidth).toBeLessThan(geometry.stageWidth*.46);
    expect(geometry.panelHeight).toBeLessThan(geometry.stageHeight*.9);
  }
  expect(errors).toEqual([]);
});


test('real player: separate source groups remain selectable before the current clip ends', async ({ page }) => {
  await load(page, [
    observation('talk', 0, { phase: 'STORY', duration: 9,
      storyEvidenceLevel: 'fact', storyConfidence: .95, narrativeChoiceLabel: 'Konuşma' }),
    observation('opening', 12, { phase: 'APPROACH', duration: 6 }),
    observation('core', 20, { phase: 'CORE', duration: 2 })
  ]);
  const map = page.locator('.gameplay-source-navigator');
  await expect(map).toHaveCount(1);
  await map.locator('summary').click();
  await expect(map.locator('.gameplay-source-group')).toHaveCount(3);
  await expect(map.locator('.gameplay-source-group').nth(0)).toContainText('Konuşmalar ve hikâye');
  await expect(map.locator('.gameplay-source-group').nth(1)).toContainText('Yakınlaşma');
  await expect(map.locator('.gameplay-source-group').nth(2)).toContainText('Ana etkileşimler');
  await map.getByRole('button', { name: 'Konuşma' }).click();
  await expect.poll(() => page.evaluate(() => __gameplayTest.state().selection?.choiceId)).toContain('talk');
  // No need to wait for the nine-second conversation to end.
  await map.locator('summary').click();
  await map.getByRole('button', { name: 'Gözlenen eylem opening' }).click();
  await expect.poll(() => page.locator('#video').evaluate(v => v.currentTime)).toBeGreaterThan(12);
  await expect.poll(() => page.evaluate(() => __gameplayTest.state().selection?.choiceId)).toContain('opening');
  // A further source jump is also immediately available during the second clip.
  await map.locator('summary').click();
  await map.getByRole('button', { name: 'Gözlenen eylem core' }).click();
  await expect.poll(() => page.locator('#video').evaluate(v => v.currentTime)).toBeGreaterThan(20);
  await expect.poll(() => page.evaluate(() => __gameplayTest.state().selection?.choiceId)).toContain('core');
  await expect(page.locator('#adultInteractionPanel')).toBeHidden();
});
