import type { Page, Request } from 'playwright';
import { FlowError } from '../domain/workflow';

/** Observe the file transfer itself, not an unrelated invoice-list response.
 * A completed transfer is not business success: the caller must find the exact
 * invoice number in the default folder afterwards.
 */
export function watchInvoiceUpload(page: Page) {
  const pending = new Set<Request>();
  let seen = false, failed = false;
  const request = (req: Request) => {
    const contentType = req.headers()['content-type'] || '';
    if (req.method() !== 'POST' || !/multipart\/form-data|application\/pdf|application\/octet-stream/i.test(contentType)) return;
    seen = true;
    pending.add(req);
  };
  const finished = async (req: Request) => {
    if (!pending.has(req)) return;
    try {
      const response = await req.response();
      if (!response?.ok()) failed = true;
    } catch { failed = true; }
    finally { pending.delete(req); }
  };
  const rejected = (req: Request) => {
    if (!pending.has(req)) return;
    failed = true;
    pending.delete(req);
  };
  page.on('request', request);
  page.on('requestfinished', finished);
  page.on('requestfailed', rejected);
  return {
    async wait(timeout: number): Promise<void> {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (failed) throw new FlowError('invoice_upload_failed');
        if (seen && pending.size === 0) return;
        if (page.isClosed()) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new FlowError('invoice_upload_pending');
    },
    dispose() {
      page.off('request', request);
      page.off('requestfinished', finished);
      page.off('requestfailed', rejected);
    },
  };
}
