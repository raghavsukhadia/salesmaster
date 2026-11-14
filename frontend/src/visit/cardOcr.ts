// Reads text off a photographed visiting card, entirely in the browser.
// The engine (Tesseract compiled to WebAssembly) and its English model are served from /ocr on our own origin
// (see scripts/copy-ocr-assets.mjs). The photo never leaves the device. The engine is a dynamic import, so the
// ~3 MB model and the wasm are only downloaded when somebody actually scans a card.

export interface OcrProgress {
  /** 0..1 within the current stage. */
  progress: number
  /** Plain-language stage for the UI. */
  stage: 'preparing' | 'loading' | 'reading'
}

/** Longest side, in pixels, the engine sees. Phone photos are 4000+ px: slow and no more accurate. */
const MAX_SIDE = 2000
/** Small images (a screenshot, a thumbnail) are scaled up: the engine needs text roughly 25+ px tall. */
const MIN_SIDE = 1200

export class CardImageError extends Error {}

/** Decode (honouring EXIF rotation), resize, convert to grayscale and stretch the contrast. */
export async function prepareCardImage(file: Blob): Promise<HTMLCanvasElement> {
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
    ctx.drawImage(bitmap, 0, 0, w, h)

    const img = ctx.getImageData(0, 0, w, h)
    const px = img.data
    const hist = new Uint32Array(256)
    for (let i = 0; i < px.length; i += 4) {
      const g = ((px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000) | 0
      px[i] = px[i + 1] = px[i + 2] = g
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
      for (let i = 0; i < px.length; i += 4) px[i] = px[i + 1] = px[i + 2] = Math.max(0, Math.min(255, (px[i] - lo) * k))
    }
    ctx.putImageData(img, 0, 0)
    return canvas
  } finally {
    bitmap.close()
  }
}

const absolute = (path: string) => new URL(import.meta.env.BASE_URL + path, window.location.href).href

/**
 * Recognise the text on a card photo. Resolves with the raw text (possibly empty: the caller decides what "nothing read" means).
 * Aborting `signal` stops the engine and rejects with an AbortError.
 */
export async function readCard(file: Blob, opts: { onProgress?: (p: OcrProgress) => void; signal?: AbortSignal } = {}): Promise<string> {
  const { onProgress, signal } = opts
  const aborted = () => new DOMException('Scan cancelled', 'AbortError')
  if (signal?.aborted) throw aborted()

  onProgress?.({ stage: 'preparing', progress: 0 })
  const canvas = await prepareCardImage(file)
  if (signal?.aborted) throw aborted()

  onProgress?.({ stage: 'loading', progress: 0 })
  const { createWorker } = await import('tesseract.js')
  const worker = await createWorker('eng', 1 /* LSTM only */, {
    workerPath: absolute('ocr/worker.min.js'),
    corePath: absolute('ocr'),
    langPath: absolute('ocr/lang'),
    gzip: true,
    logger: (m) => {
      if (m.status === 'recognizing text') onProgress?.({ stage: 'reading', progress: m.progress })
      else if (m.status.startsWith('loading') || m.status.startsWith('initializing')) onProgress?.({ stage: 'loading', progress: m.progress })
    },
  })
  const stop = () => { void worker.terminate() }
  signal?.addEventListener('abort', stop)
  try {
    if (signal?.aborted) throw aborted()
    let text = (await worker.recognize(canvas)).data.text
    // Cards with scattered text blocks sometimes read as almost nothing in automatic layout mode. Sparse mode finds them.
    if (text.replace(/\s/g, '').length < 15 && !signal?.aborted) {
      await worker.setParameters({ tessedit_pageseg_mode: '11' as never })
      text = (await worker.recognize(canvas)).data.text
    }
    if (signal?.aborted) throw aborted()
    return text
  } catch (e) {
    if (signal?.aborted) throw aborted()
    throw e
  } finally {
    signal?.removeEventListener('abort', stop)
    await worker.terminate().catch(() => {})
  }
}
