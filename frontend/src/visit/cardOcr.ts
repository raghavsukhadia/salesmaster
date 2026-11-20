// Reads text off a photographed visiting card, entirely in the browser.
// The engine (Tesseract compiled to WebAssembly) and its English model are served from /ocr on our own origin
// (see scripts/copy-ocr-assets.mjs). The photo never leaves the device. The engine is a dynamic import, so the
// ~3 MB model and the wasm are only downloaded when somebody actually scans a card.
//
// One read of one image is unreliable on real cards (logos, coloured bands, shadows, scattered text), so each photo is
// read several ways and the parser later merges the results field by field (see mergeCardReads in cardParser.ts).
import { binarize, textAmount, textFromBlocks, type OcrBlock } from './cardImage.ts'

export interface OcrProgress {
  /** 0..1 within the current stage. */
  progress: number
  /** Plain-language stage for the UI. */
  stage: 'preparing' | 'loading' | 'reading'
}

/** One read of one photo: the text kept (low-confidence lines dropped) and the engine's mean confidence, 0..100. */
export interface OcrPass { text: string; confidence: number }

/** Longest side, in pixels, the engine sees. Phone photos are 4000+ px: slow and no more accurate. */
const MAX_SIDE = 2000
/** Small images (a screenshot, a thumbnail) are scaled up: the engine needs text roughly 25+ px tall. */
const MIN_SIDE = 1200
/** Below this much text across every read, the photo is probably sideways, so it is also read rotated. */
const TOO_LITTLE_TEXT = 25

export class CardImageError extends Error {}

interface Prepared { gray: Uint8Array; w: number; h: number }

/** Decode (honouring EXIF rotation), resize, convert to grayscale and stretch the contrast. */
async function prepareCardImage(file: Blob): Promise<Prepared> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    throw new CardImageError('This image could not be opened. Use a JPEG or PNG photo.')
  }
  try {
    const long = Math.max(bitmap.width, bitmap.height)
    const scale = long > MAX_SIDE ? MAX_SIDE / long : long < MIN_SIDE ? Math.min(2.5, MIN_SIDE / long) : 1
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new CardImageError('This browser cannot process images.')
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0, w, h)

    const px = ctx.getImageData(0, 0, w, h).data
    const gray = new Uint8Array(w * h)
    const hist = new Uint32Array(256)
    for (let i = 0, j = 0; i < px.length; i += 4, j++) {
      const g = ((px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000) | 0
      gray[j] = g
      hist[g]++
    }
    // Stretch between the 1st and 99th percentile so a dim photo uses the full range. Skipped for already flat images.
    const total = w * h
    let lo = 0
    let hi = 255
    for (let v = 0, acc = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * 0.01) { lo = v; break } }
    for (let v = 255, acc = 0; v >= 0; v--) { acc += hist[v]; if (acc >= total * 0.01) { hi = v; break } }
    if (hi - lo > 40) {
      const k = 255 / (hi - lo)
      for (let j = 0; j < gray.length; j++) gray[j] = Math.max(0, Math.min(255, (gray[j] - lo) * k))
    }
    return { gray, w, h }
  } finally {
    bitmap.close()
  }
}

/** A grey image as a canvas, optionally turned a quarter (1) or three quarters (3) clockwise. */
function toCanvas(gray: Uint8Array, w: number, h: number, quarterTurns: 0 | 1 | 3 = 0): HTMLCanvasElement {
  const flat = document.createElement('canvas')
  flat.width = w
  flat.height = h
  const ctx = flat.getContext('2d')
  if (!ctx) throw new CardImageError('This browser cannot process images.')
  const img = ctx.createImageData(w, h)
  for (let i = 0, j = 0; j < gray.length; i += 4, j++) {
    img.data[i] = img.data[i + 1] = img.data[i + 2] = gray[j]
    img.data[i + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  if (!quarterTurns) return flat
  const turned = document.createElement('canvas')
  turned.width = h
  turned.height = w
  const t = turned.getContext('2d')
  if (!t) throw new CardImageError('This browser cannot process images.')
  t.translate(h / 2, w / 2)
  t.rotate((quarterTurns * Math.PI) / 2)
  t.drawImage(flat, -w / 2, -h / 2)
  return turned
}

const absolute = (path: string) => new URL(import.meta.env.BASE_URL + path, window.location.href).href

/** Tesseract page segmentation modes used here: automatic layout, and "sparse text" which finds scattered blocks. */
const PSM_AUTO = '3'
const PSM_SPARSE = '11'

/**
 * Recognise the text on a card photo, several ways. Resolves with every read (some may be empty: the caller decides what
 * "nothing read" means). Aborting `signal` stops the engine and rejects with an AbortError.
 *
 * Reads: the cleaned-up grey photo in automatic layout; a black-and-white version (shadows and coloured backgrounds removed,
 * white-on-dark bands flipped) in automatic layout; the grey photo again in sparse-text mode. Every read straightens a
 * slightly tilted photo first. If all of them find almost nothing, the photo is also read turned a quarter each way.
 */
export async function readCard(file: Blob, opts: { onProgress?: (p: OcrProgress) => void; signal?: AbortSignal } = {}): Promise<OcrPass[]> {
  const { onProgress, signal } = opts
  const aborted = () => new DOMException('Scan cancelled', 'AbortError')
  if (signal?.aborted) throw aborted()

  onProgress?.({ stage: 'preparing', progress: 0 })
  const { gray, w, h } = await prepareCardImage(file)
  if (signal?.aborted) throw aborted()
  const grey = toCanvas(gray, w, h)
  onProgress?.({ stage: 'preparing', progress: 0.5 })
  const bw = toCanvas(binarize(gray, w, h), w, h)
  if (signal?.aborted) throw aborted()

  const plan: { image: HTMLCanvasElement; psm: string }[] = [
    { image: grey, psm: PSM_AUTO },
    { image: bw, psm: PSM_AUTO },
    { image: grey, psm: PSM_SPARSE },
  ]
  let current = 0
  let planned = plan.length

  onProgress?.({ stage: 'loading', progress: 0 })
  const { createWorker } = await import('tesseract.js')
  const worker = await createWorker('eng', 1 /* LSTM only */, {
    workerPath: absolute('ocr/worker.min.js'),
    corePath: absolute('ocr'),
    langPath: absolute('ocr/lang'),
    gzip: true,
    logger: (m) => {
      if (m.status === 'recognizing text') onProgress?.({ stage: 'reading', progress: Math.min(1, (current + m.progress) / planned) })
      else if (m.status.startsWith('loading') || m.status.startsWith('initializing')) onProgress?.({ stage: 'loading', progress: m.progress })
    },
  })
  const stop = () => { void worker.terminate() }
  signal?.addEventListener('abort', stop)
  try {
    // Canvas images carry no resolution; telling the engine 300 dpi stops it guessing (and warning) on every read.
    await worker.setParameters({ user_defined_dpi: '300' })
    const passes: OcrPass[] = []
    let psm = ''
    const run = async (image: HTMLCanvasElement, mode: string) => {
      if (signal?.aborted) throw aborted()
      if (mode !== psm) { await worker.setParameters({ tessedit_pageseg_mode: mode as never }); psm = mode }
      const { data } = await worker.recognize(image, { rotateAuto: true }, { text: true, blocks: true })
      passes.push({ text: textFromBlocks(data.blocks as OcrBlock[] | null, data.text), confidence: data.confidence })
      current++
    }
    for (const p of plan) await run(p.image, p.psm)
    if (Math.max(...passes.map((p) => textAmount(p.text))) < TOO_LITTLE_TEXT) {
      planned += 2
      for (const turns of [1, 3] as const) await run(toCanvas(gray, w, h, turns), PSM_AUTO)
    }
    if (signal?.aborted) throw aborted()
    return passes
  } catch (e) {
    if (signal?.aborted) throw aborted()
    throw e
  } finally {
    signal?.removeEventListener('abort', stop)
    await worker.terminate().catch(() => {})
  }
}
