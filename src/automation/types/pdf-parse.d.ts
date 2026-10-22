declare module 'pdf-parse' {
  interface PdfParseResult {
    text: string;
    numpages: number;
    info: Record<string, unknown>;
  }

  function pdfParse(dataBuffer: Buffer | { data: Uint8Array; isEvalSupported: boolean }, options?: Record<string, unknown>): Promise<PdfParseResult>;
  export = pdfParse;
}
