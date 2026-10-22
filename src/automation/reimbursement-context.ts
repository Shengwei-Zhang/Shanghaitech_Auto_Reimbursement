import type { Frame, Page } from 'playwright';

/** Hidden inputs observed on the BPM editor (2026-09-24 snapshot). Their values
 * equal the editor URL's bizId/taskId/procInstId and the visible bill code. */
export const FORM_CONTEXT_FIELDS = {
  bizId: 'jobPageBizId',
  taskId: 'jobPageId',
  procInstId: 'jobPageProcInstId',
  documentNumber: 'jobPageBizCode',
  processDefinitionKey: 'jobPageProcessDefinitionKey',
  procInstStatusId: 'jobPageProcInstStatusId',
  statusId: 'jobPageStatusId',
  accountBook: 'mainAccountBook',
  reimbursementKind: 'reimbursementKind',
} as const;

export type ReimbursementFormContext = Record<keyof typeof FORM_CONTEXT_FIELDS, string>;

const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const FORMATS: Record<keyof typeof FORM_CONTEXT_FIELDS, RegExp> = {
  bizId: /^[\da-f]{32}$/i,
  taskId: UUID,
  procInstId: UUID,
  // A: 网上预约报销; D: 境内差旅单 (D209900000037, captured 2026-10-21).
  documentNumber: /^[AD]\d{1,32}$/,
  processDefinitionKey: /^[A-Za-z][\w-]{0,99}$/,
  procInstStatusId: /^[A-Za-z][\w-]{0,49}$/,
  statusId: /^[A-Za-z][\w-]{0,49}$/,
  accountBook: /^[A-Za-z0-9_-]{1,32}$/,
  reimbursementKind: /^[A-Za-z][A-Za-z0-9_-]{0,63}$/,
};

/** Values outside the observed formats become empty rather than being trusted. */
export function normalizeFormContext(raw: unknown): ReimbursementFormContext {
  const data = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  return Object.fromEntries(Object.entries(FORMATS).map(([key, format]) => {
    const value = typeof data[key] === 'string' ? (data[key] as string).trim() : '';
    return [key, format.test(value) ? value : ''];
  })) as ReimbursementFormContext;
}

/** Read-only DOM access. The page csrfToken is deliberately not part of this context. */
export async function readFormContext(root: Page | Frame): Promise<ReimbursementFormContext> {
  const raw = await root.evaluate(fields => Object.fromEntries(Object.entries(fields).map(([key, id]) => {
    const element = document.getElementById(id) as HTMLInputElement | null;
    return [key, element && typeof element.value === 'string' ? element.value : ''];
  })), FORM_CONTEXT_FIELDS);
  return normalizeFormContext(raw);
}
