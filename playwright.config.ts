import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import path from 'node:path';
const chrome = process.env.PLAYWRIGHT_EXECUTABLE_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export default defineConfig({
  testDir: './tests', testMatch: '**/*.spec.ts', timeout: 30_000,
  fullyParallel: false, workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:4318', headless: true,
    launchOptions: { executablePath: existsSync(chrome) ? chrome : undefined },
    viewport: { width: 1440, height: 1080 }, screenshot: 'only-on-failure', trace: 'retain-on-failure',
  },
  webServer: {
    command: `"${process.execPath}" dist/server/main.js`, url: 'http://127.0.0.1:4318', reuseExistingServer: false,
    env: { PORT: '4318', OA_DATA_DIR: path.resolve('test-results/web-data'), OA_LIVE_ENABLED: 'false', DEEPSEEK_API_KEY: '' },
  },
  outputDir: 'test-results/browser',
});
