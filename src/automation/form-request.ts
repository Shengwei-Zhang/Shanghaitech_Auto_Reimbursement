import type { AutomationContext } from './browser';

export const BPM_ORIGIN = 'https://sapbpm-new.shanghaitech.edu.cn:9091';

export type FormRequestError = 'bpm_unavailable' | 'form_context_missing' | 'csrf_missing' | 'csrf_ambiguous'
  | 'csrf_invalid' | 'authentication' | 'timeout' | 'request_failed' | 'http_error' | 'non_json' | 'response_invalid';

export interface FormRequest {
  pathname: string;
  payload: Record<string, string>;
  /** Payload keys left empty are filled from these hidden inputs (id → format). */
  fromForm?: Record<string, { id: string; format: RegExp }>;
  /** 'json' parses (also text/plain JSON); 'text' returns the body as inert text. */
  expect: 'json' | 'text';
  accept: string;
  timeoutMs: number;
}

export type FormRequestResult =
  | { error: FormRequestError; status?: number }
  | { error?: undefined; status: number; payload: Record<string, string>; data: unknown; contentType: string };

/** Form-encoded POST from the active BPM editor document, as its own jQuery
 * calls do: cookies and Referer belong to that document, and the csrfToken and
 * procTaskId headers come from its declarations. The token never reaches Node;
 * an echoed token is replaced by [REDACTED]. */
export async function postFromForm(ctx: AutomationContext, request: FormRequest): Promise<FormRequestResult> {
  let root: ReturnType<AutomationContext['root']>, expectedUrl: string, url: URL;
  try { root = ctx.root(); expectedUrl = root.url(); }
  catch { return { error: 'request_failed' }; }
  try { url = new URL(expectedUrl); }
  catch { return { error: 'bpm_unavailable' }; }
  if (ctx.page.isClosed() || url.origin !== BPM_ORIGIN || !url.pathname.startsWith('/bpm-new/')
    || url.username || url.password) return { error: 'bpm_unavailable' };
  const fromForm = Object.fromEntries(Object.entries(request.fromForm ?? {})
    .map(([key, { id, format }]) => [key, { id, format: format.source }]));
  try {
    return await root.evaluate(async ({ origin, pathname, expectedUrl, payload, fromForm, expect, accept, timeout }) => {
      if (location.origin !== origin || location.href !== expectedUrl) {
        return { error: 'bpm_unavailable' as const };
      }
      for (const [key, { id, format }] of Object.entries(fromForm)) {
        if (payload[key]) continue;
        const value = (document.getElementById(id) as HTMLInputElement | null)?.value?.trim() || '';
        if (!new RegExp(format).test(value)) return { error: 'form_context_missing' as const };
        payload[key] = value;
      }
      const candidates: unknown[] = [];
      // #csrfTokenElement is the live editor's declaration (2026-09-24 snapshot).
      // The editor URL also carries a csrfToken, but it differed from the
      // element in that snapshot, so the URL is never a candidate.
      const tokenElements = Array.from(document.querySelectorAll(
        'input[id="csrfTokenElement"], input[name="csrfToken"], input[id="csrfToken"], meta[name="csrfToken"]'));
      for (const element of tokenElements) {
        candidates.push(element.tagName.toLowerCase() === 'meta' ? element.getAttribute('content')
          : (element as HTMLInputElement).value);
      }
      const runtime = window as unknown as Record<string, unknown>;
      // Browsers expose an input's id as a Window named property. That is the
      // DOM source already read above, not a second non-string token value.
      if (!tokenElements.includes(runtime.csrfToken as Element)) candidates.push(runtime.csrfToken);
      for (const key of ['jQuery', '$']) {
        const jquery = runtime[key] as { ajaxSettings?: { headers?: Record<string, unknown> } } | undefined;
        const headers = jquery?.ajaxSettings?.headers;
        if (headers && typeof headers === 'object') {
          for (const [name, value] of Object.entries(headers)) {
            if (name.toLowerCase() === 'csrftoken') candidates.push(value);
          }
        }
      }
      const nonempty = candidates.filter(value => value !== undefined && value !== null && value !== '');
      if (nonempty.some(value => typeof value !== 'string' || value.length > 4096 || !/^[\x21-\x7e]+$/.test(value))) {
        return { error: 'csrf_invalid' as const };
      }
      const unique = [...new Set(nonempty as string[])];
      if (!unique.length) return { error: 'csrf_missing' as const };
      if (unique.length !== 1) return { error: 'csrf_ambiguous' as const };
      const token = unique[0];
      const headers: Record<string, string> = { Accept: accept,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest', csrfToken: token };
      // The live editor's Ajax calls also send procTaskId = #jobPageId (2026-10-15 capture).
      const procTaskId = (document.getElementById('jobPageId') as HTMLInputElement | null)?.value?.trim() || '';
      if (/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(procTaskId)) headers.procTaskId = procTaskId;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const endpoint = new URL(pathname, origin).href;
        const response = await fetch(endpoint, {
          method: 'POST', credentials: 'same-origin', mode: 'same-origin', redirect: 'manual', cache: 'no-store',
          headers, body: new URLSearchParams(payload).toString(), signal: controller.signal,
        });
        const status = response.status;
        if (response.type === 'opaqueredirect' || (status >= 300 && status < 400) || status === 401 || status === 403) {
          return { error: 'authentication' as const, status };
        }
        if (!response.ok) return { error: 'http_error' as const, status };
        if (response.url !== endpoint) return { error: 'response_invalid' as const, status };
        if (Number(response.headers.get('content-length')) > 5 * 1024 * 1024) {
          return { error: 'response_invalid' as const, status };
        }
        const text = await response.text();
        if (!text.trim() || text.length > 5 * 1024 * 1024) return { error: 'response_invalid' as const, status };
        const contentType = response.headers.get('content-type') || '';
        if (expect === 'text') return { status, payload, contentType, data: text.split(token).join('[REDACTED]') };
        // Legacy .ajax handlers can label JSON as text/plain or text/html.
        let data: unknown;
        try { data = JSON.parse(text); }
        catch {
          return { error: /^\s*[\[{]/.test(text) || /\bjson\b/i.test(contentType)
            ? 'response_invalid' as const : 'non_json' as const, status };
        }
        if (!data || typeof data !== 'object') return { error: 'response_invalid' as const, status };
        // Prevent an echoed token from escaping with an otherwise valid response.
        const scrub = (value: unknown): unknown => {
          if (typeof value === 'string') return value.split(token).join('[REDACTED]');
          if (Array.isArray(value)) return value.map(scrub);
          if (value && typeof value === 'object') {
            return Object.fromEntries(Object.entries(value).map(([key, item]) => [
              key.split(token).join('[REDACTED]'), key.toLowerCase() === 'csrftoken' ? '[REDACTED]' : scrub(item),
            ]));
          }
          return value;
        };
        return { status, payload, contentType, data: scrub(data) };
      } catch {
        return { error: controller.signal.aborted ? 'timeout' as const : 'request_failed' as const };
      } finally { clearTimeout(timer); }
    }, { origin: BPM_ORIGIN, pathname: request.pathname, expectedUrl, payload: { ...request.payload }, fromForm,
      expect: request.expect, accept: request.accept, timeout: request.timeoutMs });
  } catch {
    // Browser exceptions may include page URLs, tickets or headers.
    return { error: 'request_failed' };
  }
}
