import { test, expect } from '@playwright/test';
import { observation, evidence } from '../fixtures/gameplay-v2.js';
const source = actions => ({ videoDuration: 24, playStartTime: 0, storyContext: {}, actions });
const load = async (page, actions) => {
  await page.goto('/');
  await page.waitForFunction(() => !!globalThis.__gameplayTest);
  await page.evaluate(data => __gameplayTest.load(data), source(actions));
};

test('A/G: real app offers narrative cards and fullscreen fallback preserves choices on mobile', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await load(page, Array.from({ length: 7 }, (_, i) => observation(`story-${i}`, i * 3, {
    phase: 'STORY', duration: 2, storyEvidenceLevel: 'fact', storyConfidence: .95,
    narrativeChoiceLabel: `Gözlenen karar ${i}` })));
  await expect(page.locator('#choices .gameplay-choice')).toHaveCount(3);
  await expect(page.locator('#choices')).toBeVisible();
  await expect(page.locator('#approachChoices')).toBeHidden();
  await page.evaluate(() => { document.querySelector('.video-stage').requestFullscreen = () => Promise.reject(new Error('fixture denial')); });
  await page.locator('#fullscreenBtn').click();
  await expect(page.locator('#fullscreenStatus')).toContainText('Tam ekran açılamadı');
  await expect(page.locator('#choices .gameplay-choice')).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(errors).toEqual([]);
});

test('B/F/G: real video playback earns bounded engagement and reveals next stage without auto-seek', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await load(page, [observation('a', 0, { duration: 2 }), observation('b', 3, { duration: 2 }),
    observation('ending', 6, { duration: 2, phase: 'CORE' })]);
  await expect(page.locator('#approachChoices .gameplay-choice')).toHaveCount(2);
  await page.locator('#approachChoices .gameplay-choice').first().click();
  await expect.poll(() => page.evaluate(() => __gameplayTest.state().selection)).toBeNull();
  expect(await page.evaluate(() => Object.values(__gameplayTest.state().stageProgress)[0].score)).toBe(50);
  await page.locator('#approachChoices .gameplay-choice').nth(1).click();
  await expect(page.getByRole('button', { name: 'Sonraki aşama', exact: true })).toBeVisible();
  const time = await page.locator('#video').evaluate(video => video.currentTime);
  await page.getByRole('button', { name: 'Sonraki aşama', exact: true }).click();
  await expect(page.locator('#adultInteractionPanel')).toBeVisible();
  await expect(page.locator('#movementChoices .gameplay-choice')).toBeVisible();
  await expect(page.locator('#adultPhaseTitle')).toHaveText('Etkileşim');
  await expect(page.locator('#approachChoices')).toBeHidden();
  expect(await page.locator('#video').evaluate(video => video.currentTime)).toBeCloseTo(time, 1);
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
