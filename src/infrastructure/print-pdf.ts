import { existsSync } from 'fs';
import { getEnvValue } from '../automation/config';

/** The combined 报销单 print page as a PDF, laid out exactly as the browser prints it (OA's
 * @page and page-break rules, the watermark layer as a printed background). The page has
 * only inline images, so scripts are off and every network request is refused. */
export async function renderPrintPdf(html: string): Promise<Buffer> {
  const { chromium } = await import('playwright');
  const systemChrome = getEnvValue('PLAYWRIGHT_EXECUTABLE_PATH') || getEnvValue('CHROME_EXECUTABLE_PATH')
    || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const browser = await chromium.launch({ headless: true, ...(existsSync(systemChrome) ? { executablePath: systemChrome } : {}) });
  try {
    const context = await browser.newContext({ javaScriptEnabled: false, offline: true });
    await context.route('**/*', route => route.abort());
    const page = await context.newPage();
    await page.setContent(html.replace(/<script\b[^>]*><\/script>/gi, ''), { waitUntil: 'load', timeout: 60_000 });
    return await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
  } finally {
    await browser.close();
  }
}
