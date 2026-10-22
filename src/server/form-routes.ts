/** How a 报销类型's server module answers the page: each one registers its routes under /api/oa/ (see
 * oa-api.ts FORM_TYPES), and app.ts mounts them all the same way. Adding a type adds a module here, not a
 * branch in app.ts. */

/** An invoice of a page's form: a PDF the page sent (read and checked here) or one picked from an OA folder. */
export interface PageInvoice { fileName: string; number: string; bytes?: Buffer; folderId?: string }

/** What a route may need from the local server beyond the school login. */
export interface FormContext {
  /** OA_LIVE_ENABLED: whether a form may be written to OA at all. */
  liveEnabled: boolean;
  /** The page's `invoices` array, read and checked like a job's (folder picks re-read in OA). */
  readInvoices(value: unknown): Promise<PageInvoice[]>;
}

/** A route's answer when it created something (HTTP 201 instead of 200). */
export class Created {
  constructor(readonly body: unknown) {}
}

export type FormRoute = (method: string, url: URL, body: () => Promise<unknown>, context: FormContext) => Promise<unknown | undefined>;

/** One 报销类型 on the server. */
export interface FormType {
  /** The page's 报销类型 name, e.g. 境内差旅单. */
  name: string;
  /** Answers its own routes; undefined for any other path. */
  route: FormRoute;
}
