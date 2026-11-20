// Pure pixel and text helpers for card scanning. No DOM and no OCR engine here, so they run under `npm test`.

/** Grey level below which a pixel counts as dark when looking for dark backgrounds. */
const DARK = 110
/** Size, in pixels, of the cells used to find dark backgrounds (header bands, dark logos, a table around the card). */
const CELL = 16
/** Adaptive threshold: a pixel is ink when it is this much darker than its neighbourhood... */
const T = 0.15
/** ...and at least this many grey levels darker, so faint noise on a flat background stays white. */
const MIN_DIFF = 15

function morph(mask: Uint8Array, w: number, h: number, r: number, grow: boolean): Uint8Array {
  const out = new Uint8Array(mask.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let hit = !grow
      for (let dy = -r; dy <= r && hit !== grow; dy++) {
        const yy = y + dy
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx
          // Outside the image counts as background for growing and as foreground for shrinking, so edges are not eaten.
          const v = yy < 0 || yy >= h || xx < 0 || xx >= w ? !grow : mask[yy * w + xx] === 1
          if (grow && v) { hit = true; break }
          if (!grow && !v) { hit = false; break }
        }
      }
      out[y * w + x] = hit ? 1 : 0
    }
  }
  return out
}
const dilate = (m: Uint8Array, w: number, h: number, r: number) => morph(m, w, h, r, true)
const erode = (m: Uint8Array, w: number, h: number, r: number) => morph(m, w, h, r, false)

/**
 * Inverts large dark areas in place, so white text on a coloured header band becomes dark text on a light band.
 * A cell is dark when most of its pixels are dark (the median, not the mean, so bold black lettering on white does not count).
 * Closing fills the holes the white letters leave; opening then drops anything too small to be a background (text, specks).
 */
export function invertDarkAreas(gray: Uint8Array, w: number, h: number): void {
  const cw = Math.ceil(w / CELL)
  const ch = Math.ceil(h / CELL)
  const dark = new Uint32Array(cw * ch)
  const all = new Uint32Array(cw * ch)
  for (let y = 0; y < h; y++) {
    const row = ((y / CELL) | 0) * cw
    for (let x = 0; x < w; x++) {
      const c = row + ((x / CELL) | 0)
      all[c]++
      if (gray[y * w + x] < DARK) dark[c]++
    }
  }
  let mask: Uint8Array = new Uint8Array(cw * ch)
  for (let c = 0; c < mask.length; c++) mask[c] = dark[c] * 2 > all[c] ? 1 : 0
  mask = erode(dilate(mask, cw, ch, 1), cw, ch, 1)
  mask = dilate(erode(mask, cw, ch, 2), cw, ch, 2)
  for (let y = 0; y < h; y++) {
    const row = ((y / CELL) | 0) * cw
    for (let x = 0; x < w; x++) if (mask[row + ((x / CELL) | 0)]) gray[y * w + x] = 255 - gray[y * w + x]
  }
}

/**
 * Black text on a white page from a grey photo: dark areas are inverted first, then each pixel is compared with the mean of
 * its neighbourhood (Bradley's adaptive threshold), which copes with shadows, uneven light and coloured or textured cards.
 */
export function binarize(gray: ArrayLike<number>, w: number, h: number): Uint8Array {
  const g = Uint8Array.from(gray)
  invertDarkAreas(g, w, h)
  const W = w + 1
  const sum = new Uint32Array(W * (h + 1)) // integral image: sum of every pixel above and to the left
  for (let y = 0; y < h; y++) {
    let row = 0
    for (let x = 0; x < w; x++) {
      row += g[y * w + x]
      sum[(y + 1) * W + x + 1] = sum[y * W + x + 1] + row
    }
  }
  const r = Math.max(8, Math.round(Math.max(w, h) / 24))
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r)
    const y1 = Math.min(h, y + r + 1)
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r)
      const x1 = Math.min(w, x + r + 1)
      const mean = (sum[y1 * W + x1] - sum[y0 * W + x1] - sum[y1 * W + x0] + sum[y0 * W + x0]) / ((x1 - x0) * (y1 - y0))
      const v = g[y * w + x]
      out[y * w + x] = v < mean * (1 - T) && mean - v > MIN_DIFF ? 0 : 255
    }
  }
  return out
}

/** The parts of an OCR result this module reads (structurally the same as Tesseract's blocks). */
export interface OcrBlock { paragraphs: { lines: { text: string; confidence: number }[] }[] }

/** Lines read with less confidence than this are usually a logo, a border or a background pattern read as letters. */
export const MIN_LINE_CONFIDENCE = 35

/**
 * The text of an OCR result, one line per line, without the lines the engine itself had little faith in.
 * A line holding a long run of digits is kept whatever its confidence: the parser checks numbers strictly on its own.
 */
export function textFromBlocks(blocks: OcrBlock[] | null | undefined, fallback: string): string {
  if (!blocks?.length) return fallback
  const keep: string[] = []
  for (const b of blocks) {
    for (const p of b.paragraphs) {
      for (const l of p.lines) {
        const text = l.text.trim()
        if (!text) continue
        if (l.confidence >= MIN_LINE_CONFIDENCE || (text.match(/\d/g) ?? []).length >= 6) keep.push(text)
      }
    }
  }
  return keep.join('\n')
}

/** How much usable text a read produced: letters and digits only, so a page of punctuation counts as nothing. */
export const textAmount = (text: string) => (text.match(/[A-Za-z0-9]/g) ?? []).length
