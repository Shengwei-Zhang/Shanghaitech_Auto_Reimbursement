/** The part of pngjs (no bundled types) that decodeImage uses. */
declare module 'pngjs' {
  export const PNG: { sync: { read(buffer: Buffer): { width: number; height: number; data: Buffer } } };
}
