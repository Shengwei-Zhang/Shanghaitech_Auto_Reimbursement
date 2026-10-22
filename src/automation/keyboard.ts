import { execFile } from 'child_process';
import { promisify } from 'util';
import type { Locator } from 'playwright';
import { DEFAULT_TIMEOUT_MS } from './config';
import type { AutomationContext } from './browser';

const execFileAsync = promisify(execFile);
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';

export async function nativeReplaceElementValue(ctx: AutomationContext, locator: Locator, value: string): Promise<void> {
  const element = locator.first();
  await element.scrollIntoViewIfNeeded();
  await element.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT_MS });
  await element.click();
  await ctx.page.keyboard.press(`${modifier}+a`);
  await ctx.page.keyboard.press('Backspace');
  await ctx.page.keyboard.type(String(value));
  await ctx.page.keyboard.press('Tab');
}

export async function nativeReplaceValueAtPoint(ctx: AutomationContext, point: { x: number; y: number }, value: string): Promise<void> {
  await ctx.page.mouse.click(Math.round(point.x), Math.round(point.y));
  await ctx.page.waitForTimeout(200);
  await ctx.page.keyboard.press(`${modifier}+a`);
  await ctx.page.keyboard.press('Backspace');
  await ctx.page.keyboard.type(String(value));
  await ctx.page.keyboard.press('Tab');
}

export async function nativePasteValueAtPoint(ctx: AutomationContext, point: { x: number; y: number }, value: string): Promise<void> {
  if (process.platform === 'darwin') {
    await execFileAsync('osascript', ['-e', `set the clipboard to ${JSON.stringify(String(value))}`]);
  }

  await ctx.page.mouse.click(Math.round(point.x), Math.round(point.y));
  await ctx.page.waitForTimeout(200);
  await ctx.page.keyboard.press(`${modifier}+a`);
  await ctx.page.keyboard.press('Backspace');

  if (process.platform === 'darwin') {
    await ctx.page.keyboard.press('Meta+v');
  } else {
    await ctx.page.keyboard.type(String(value));
  }

  await ctx.page.keyboard.press('Tab');
}
