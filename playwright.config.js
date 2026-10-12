import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';
export default defineConfig({
  testDir: './test/browser', testMatch: '*.spec.js', timeout: 30000, workers: 1,
  outputDir: 'work/browser/results', reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:4174', headless: true, trace: 'retain-on-failure',
    launchOptions: { executablePath: process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
      args: ['--no-sandbox'] } },
  projects: [{ name: 'desktop', use: { viewport: { width: 1280, height: 800 } } },
    { name: 'android', use: { ...devices['Pixel 7'], defaultBrowserType: 'chromium' } }],
  webServer: { command: 'node test/browser/server.mjs', url: 'http://127.0.0.1:4174', reuseExistingServer: false }
});
