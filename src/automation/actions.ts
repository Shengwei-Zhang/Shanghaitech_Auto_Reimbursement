import fs from 'fs/promises';
import path from 'path';
import type { Locator } from 'playwright';
import { DEFAULT_TIMEOUT_MS, getEnvValue, isEnvTrue } from './config';
import type { AutomationContext } from './browser';
import type { DebugStatePaths } from './types';
import { FlowError } from '../domain/workflow';

const ARTIFACT_ROOT = path.resolve(getEnvValue('OA_ARTIFACT_DIR') || 'data/cli-artifacts');
export const SCREENSHOT_DIR = path.join(ARTIFACT_ROOT, 'screenshots');
export const DEBUG_DIR = path.join(ARTIFACT_ROOT, 'debug');
export const ARIA_SNAPSHOT_DIR = path.join(ARTIFACT_ROOT, 'aria');

function allowArtifacts(ctx: AutomationContext): boolean {
  return isEnvTrue('CAPTURE_DEBUG_ARTIFACTS') && ctx.state.stage !== 'authenticate';
}

const DEFAULT_RETRY_ATTEMPTS = Number(process.env.PLAYWRIGHT_RETRY_ATTEMPTS || process.env.SELENIUM_RETRY_ATTEMPTS || 2);

function sanitizeFilePart(value: string): string {
  return String(value)
    .replace(/[^a-z0-9-_]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'step';
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export async function takeScreenshot(ctx: AutomationContext, label = 'failure'): Promise<string> {
  if (!allowArtifacts(ctx)) return '(disabled)';
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
  const filePath = path.join(SCREENSHOT_DIR, `${timestamp()}-${sanitizeFilePart(label)}.png`);
  await ctx.page.screenshot({ path: filePath, fullPage: true });
  return filePath;
}

export async function saveAriaSnapshot(ctx: AutomationContext, label = 'failure'): Promise<string> {
  if (!allowArtifacts(ctx)) return '(disabled)';
  await fs.mkdir(ARIA_SNAPSHOT_DIR, { recursive: true });
  const filePath = path.join(ARIA_SNAPSHOT_DIR, `${timestamp()}-${sanitizeFilePart(label)}.aria.yml`);
  const snapshot = await ctx.root().locator('body').ariaSnapshot();
  await fs.writeFile(filePath, snapshot, 'utf8');
  return filePath;
}

export async function saveDebugState(ctx: AutomationContext, label = 'failure'): Promise<DebugStatePaths> {
  if (!allowArtifacts(ctx)) return { htmlPath: '(disabled)', jsonPath: '(disabled)', ariaPath: '(disabled)' };
  await fs.mkdir(DEBUG_DIR, { recursive: true });

  const safeLabel = sanitizeFilePart(label);
  const basePath = path.join(DEBUG_DIR, `${timestamp()}-${safeLabel}`);
  const currentUrl = ctx.page.url();
  const title = await ctx.page.title().catch(() => '');
  const pageSource = await ctx.root().content().catch(() => '');
  const ariaSnapshot = await ctx.root().locator('body').ariaSnapshot().catch(() => '');

  const visibleElements = await ctx.root().evaluate(() => {
    function isVisible(element: Element) {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0
        && rect.height > 0
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity) !== 0;
    }

    return Array.from(document.querySelectorAll('input, textarea, select, button, a, [role="button"]'))
      .filter(isVisible)
      .slice(0, 300)
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        id: element.id || '',
        name: element.getAttribute('name') || '',
        type: element.getAttribute('type') || '',
        text: (element.textContent || (element as HTMLInputElement).value || '').trim().slice(0, 120),
        placeholder: element.getAttribute('placeholder') || '',
        className: element.className || '',
        ariaLabel: element.getAttribute('aria-label') || '',
        role: element.getAttribute('role') || '',
      }));
  }).catch(() => []);

  const allTabs = await Promise.all(ctx.page.context().pages().map(async (page) => ({
    url: page.url(),
    title: await page.title().catch(() => ''),
    isCurrent: page === ctx.page,
  })));
  const frameSummaries = await Promise.all(ctx.page.frames().map(async (frame) => ({
    url: frame.url(),
    name: frame.name(),
    text: (await frame.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 500),
  })));
  const pickerState = await ctx.root().evaluate(() => ({
    pickerVisible: /发票列表/.test(document.body.innerText || '')
      && /自行上传票据|表单默认票夹/.test(document.body.innerText || ''),
    fileInputCount: document.querySelectorAll(
      'input[type="file"], input[name="upload"], .webuploader-element-invisible',
    ).length,
    visibleDialogs: Array.from(document.querySelectorAll(
      '.ui_dialog, .ui-dialog, [id^="ldg_dialog"], .l-dialog',
    )).map((dialog) => (dialog.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160)),
  })).catch(() => ({
    pickerVisible: false,
    fileInputCount: 0,
    visibleDialogs: [] as string[],
  }));

  const ariaPath = `${basePath}.aria.yml`;
  await fs.writeFile(`${basePath}.html`, pageSource, 'utf8');
  await fs.writeFile(ariaPath, ariaSnapshot, 'utf8');
  await fs.writeFile(`${basePath}.json`, JSON.stringify({
    label,
    stage: ctx.state.stage,
    currentUrl,
    activeFrameUrl: ctx.activeFrameUrl(),
    title,
    mode: {
      cdp: Boolean(getEnvValue('CHROME_DEBUGGER_ADDRESS') || getEnvValue('PLAYWRIGHT_CDP_ENDPOINT')),
      resumeExisting: isEnvTrue('RESUME_EXISTING'),
      startFrom: getEnvValue('START_FROM'),
    },
    runState: ctx.state,
    allTabs,
    frameSummaries,
    pickerState,
    visibleElements,
    ariaSnapshotPath: ariaPath,
  }, null, 2), 'utf8');

  return {
    htmlPath: `${basePath}.html`,
    jsonPath: `${basePath}.json`,
    ariaPath,
  };
}

async function withFailureArtifacts(ctx: AutomationContext, label: string, action: () => Promise<unknown>) {
  try {
    return await action();
  } catch (error) {
    const screenshotPath = await takeScreenshot(ctx, label).catch(() => '(unavailable)');
    const ariaPath = await saveAriaSnapshot(ctx, label).catch(() => '');
    const message = error instanceof Error ? error.message : String(error);
    const suffix = ariaPath
      ? `\nScreenshot saved to: ${screenshotPath}\nARIA snapshot saved to: ${ariaPath}`
      : `\nScreenshot saved to: ${screenshotPath}`;
    throw new Error(`${message}${suffix}`);
  }
}

async function waitForVisible(locator: Locator, timeoutMs = DEFAULT_TIMEOUT_MS) {
  await locator.first().waitFor({ state: 'visible', timeout: timeoutMs });
  return locator.first();
}

export async function waitAndClick(
  ctx: AutomationContext,
  locator: Locator,
  label: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
) {
  return withFailureArtifacts(ctx, label || 'wait-and-click', async () => {
    const target = await waitForVisible(locator, timeoutMs);
    await target.click({ timeout: timeoutMs });
    return target;
  });
}

export async function clickViaJs(
  ctx: AutomationContext,
  locator: Locator,
  label: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
) {
  return withFailureArtifacts(ctx, label || 'click-via-js', async () => {
    const target = await waitForVisible(locator, timeoutMs);
    await target.evaluate((element) => {
      (element as HTMLElement).click();
    });
    return target;
  });
}

export async function waitAndType(
  ctx: AutomationContext,
  locator: Locator,
  value: string,
  label: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
) {
  return withFailureArtifacts(ctx, label || 'wait-and-type', async () => {
    const target = await waitForVisible(locator, timeoutMs);
    await target.fill(value, { timeout: timeoutMs });
    return target;
  });
}

export async function dismissBrowserUiOverlays(ctx: AutomationContext): Promise<void> {
  // Close Chrome in-page Find bar (Cmd+F) if macOS keystrokes hit the browser by mistake.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await ctx.page.keyboard.press('Escape').catch(() => undefined);
    await ctx.page.waitForTimeout(120);
  }
}

export async function retryStep<T>(label: string, step: () => Promise<T>, attempts = DEFAULT_RETRY_ATTEMPTS): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await step();
    } catch (error) {
      if (error instanceof FlowError) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt === attempts) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }

  throw new Error(`Step failed after ${attempts} attempts: ${label}\n${lastError?.message ?? 'Unknown error'}`);
}
