import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef } from 'pdf-lib';

/** Local OCR for 行程附件 that have no text layer: PaddleOCR (paddleocr.js, PP-OCRv5 mobile) on
 * onnxruntime-node. Models are files in OA_OCR_MODEL_DIR (default data/ocr-models, from
 * ModelScope RapidAI/RapidOCR, see docs/http-travel.md); images never leave this machine. */
export const OCR_MODEL_FILES = {
  detection: 'ch_PP-OCRv5_det_mobile.onnx',
  recognition: 'ch_PP-OCRv5_rec_mobile.onnx',
  orientation: 'ch_PP-LCNet_x0_25_textline_ori_cls_mobile.onnx',
  dictionary: 'ppocrv5_dict.txt',
} as const;

export class OcrUnavailableError extends Error {
  constructor(detail: string) { super(`本机 OCR 不可用：${detail}`); this.name = 'OcrUnavailableError'; }
}

export interface Pixels { width: number; height: number; data: Uint8Array }
type Recognizer = (image: Pixels) => Promise<string>;

let loading: Promise<Recognizer> | undefined;
/** Only one image at a time: the models use every core already. */
let queue: Promise<unknown> = Promise.resolve();

export function ocrModelDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.OA_OCR_MODEL_DIR?.trim() || path.join(env.OA_DATA_DIR?.trim() || 'data', 'ocr-models'));
}

const arrayBuffer = (buffer: Buffer) => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;

async function load(): Promise<Recognizer> {
  const dir = ocrModelDir();
  const missing = Object.values(OCR_MODEL_FILES).filter(name => !fs.existsSync(path.join(dir, name)));
  if (missing.length) throw new OcrUnavailableError(`${dir} 中缺少模型文件 ${missing.join('、')}`);
  let ort: unknown, paddle: typeof import('paddleocr');
  try {
    ort = await import('onnxruntime-node');
    paddle = await import('paddleocr');
  } catch { throw new OcrUnavailableError('未安装 paddleocr / onnxruntime-node（npm install）'); }
  const read = (name: string) => fs.readFileSync(path.join(dir, name));
  // The recognition model has blank + dictionary + space classes; the file holds only the dictionary.
  const dictionary = [...read(OCR_MODEL_FILES.dictionary).toString('utf8').split(/\r?\n/).filter(Boolean), ' '];
  const ocr = await paddle.PaddleOcrService.createInstance({ ort: ort as never, modelPreset: 'PP-OCRv5_mobile',
    detection: { modelBuffer: arrayBuffer(read(OCR_MODEL_FILES.detection)) },
    recognition: { modelBuffer: arrayBuffer(read(OCR_MODEL_FILES.recognition)), charactersDictionary: dictionary },
    textlineOrientation: { modelBuffer: arrayBuffer(read(OCR_MODEL_FILES.orientation)), threshold: 0.9 } });
  return async image => ocr.processRecognition(await ocr.recognize(image)).text;
}

/** Text of one image, lines in reading order. Loads the models on first use. */
export async function recognizeText(image: Pixels): Promise<string> {
  loading ??= load().catch(error => { loading = undefined; throw error; });
  const recognize = await loading;
  const run = queue.then(() => recognize(image), () => recognize(image));
  queue = run.catch(() => undefined);
  return run;
}

/** PNG or JPEG bytes → RGBA pixels (pure JS decoders; HEIC and others are refused). */
export async function decodeImage(buffer: Buffer): Promise<Pixels> {
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    const { PNG } = await import('pngjs');
    const png = PNG.sync.read(buffer);
    return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    const jpeg = await import('jpeg-js');
    const image = jpeg.decode(buffer, { useTArray: true, maxMemoryUsageInMB: 1024, formatAsRGBA: true });
    return { width: image.width, height: image.height, data: image.data };
  }
  throw new OcrUnavailableError('只能识别 PNG 和 JPEG 图片');
}

/** The page images of a scanned PDF: JPEG streams as they are, 8-bit Flate RGB/gray as pixels.
 * Small images (logos, stamps) are skipped; at most `limit` are returned, largest first. */
export async function pdfImages(buffer: Buffer, limit = 4): Promise<Pixels[]> {
  const doc = await PDFDocument.load(buffer, { updateMetadata: false, ignoreEncryption: true });
  const found: Array<Pixels & { area: number }> = [];
  const objects = doc.context.enumerateIndirectObjects();
  // Transparency masks are images too; they hold no text.
  const masks = new Set(objects.flatMap(([, object]) => {
    const mask = object instanceof PDFRawStream ? object.dict.get(PDFName.of('SMask')) : undefined;
    return mask instanceof PDFRef ? [mask.toString()] : [];
  }));
  /** Colour components: DeviceRGB/Gray, or the N of an ICCBased profile; 0 for anything else. */
  const components = (value: unknown): number => {
    const space = value instanceof PDFRef ? doc.context.lookup(value) : value;
    if (space instanceof PDFName) return space.toString() === '/DeviceRGB' ? 3 : space.toString() === '/DeviceGray' ? 1 : 0;
    if (space instanceof PDFArray && space.get(0)?.toString() === '/ICCBased') {
      const profile = doc.context.lookup(space.get(1));
      const n = profile instanceof PDFRawStream ? (profile.dict.lookup(PDFName.of('N')) as PDFNumber | undefined)?.asNumber?.() : undefined;
      return n === 3 || n === 1 ? n : 0;
    }
    return 0;
  };
  for (const [ref, object] of objects) {
    if (!(object instanceof PDFRawStream) || object.dict.get(PDFName.of('Subtype'))?.toString() !== '/Image' || masks.has(ref.toString())) continue;
    const number = (key: string) => (object.dict.lookup(PDFName.of(key)) as PDFNumber | undefined)?.asNumber?.() ?? 0;
    const width = number('Width'), height = number('Height');
    if (width * height < 300 * 300) continue;
    const filter = String(object.dict.get(PDFName.of('Filter')) ?? '');
    try {
      if (filter.includes('DCTDecode')) {
        found.push({ ...(await decodeImage(Buffer.from(object.contents))), area: width * height });
      } else if (filter === '/FlateDecode' && number('BitsPerComponent') === 8 && !(object.dict.get(PDFName.of('DecodeParms')) instanceof PDFDict)) {
        const channels = components(object.dict.get(PDFName.of('ColorSpace')));
        const raw = zlib.inflateSync(Buffer.from(object.contents));
        if (!channels || raw.length < width * height * channels) continue;
        const data = new Uint8Array(width * height * 4);
        for (let i = 0; i < width * height; i++) {
          for (let c = 0; c < 3; c++) data[i * 4 + c] = raw[i * channels + (channels === 3 ? c : 0)];
          data[i * 4 + 3] = 255;
        }
        found.push({ width, height, data, area: width * height });
      }
    } catch { /* an image this reader cannot decode is skipped */ }
  }
  return found.sort((a, b) => b.area - a.area).slice(0, limit).map(({ width, height, data }) => ({ width, height, data }));
}
