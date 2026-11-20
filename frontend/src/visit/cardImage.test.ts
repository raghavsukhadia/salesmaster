/// <reference types="node" />
// Run with: npm test   (node --test, native TypeScript type stripping)
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { binarize, MIN_LINE_CONFIDENCE, textAmount, textFromBlocks } from './cardImage.ts'

const W = 400
const H = 200

/** A grey image filled by `paint(x, y)`. */
function image(paint: (x: number, y: number) => number): Uint8Array {
  const g = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g[y * W + x] = paint(x, y)
  return g
}
/** A 6 px wide vertical "stroke" every 30 px between x 100 and 300, y 80 to 120: stands in for a line of text. */
const inStroke = (x: number, y: number) => y >= 80 && y < 120 && x >= 100 && x < 300 && x % 30 < 6
const at = (img: Uint8Array, x: number, y: number) => img[y * W + x]

test('dark text on a light card comes out black on white', () => {
  const out = binarize(image((x, y) => (inStroke(x, y) ? 40 : 230)), W, H)
  assert.equal(at(out, 121, 100), 0)
  assert.equal(at(out, 135, 100), 255)
  assert.equal(at(out, 10, 10), 255)
})

test('a shadow across the card does not turn into ink, the text under it still does', () => {
  // Background fades from 240 on the left to 120 on the right, text stays 60 darker than its background.
  const out = binarize(image((x, y) => { const bg = 240 - (120 * x) / W; return inStroke(x, y) ? bg - 60 : bg }), W, H)
  for (const x of [20, 200, 380]) assert.equal(at(out, x, 20), 255, `background at x=${x}`)
  assert.equal(at(out, 121, 100), 0)
  assert.equal(at(out, 272, 100), 0)
})

test('white text on a dark header band is flipped to black text on white', () => {
  // A dark band over the top 160 px of the card, with white strokes in it.
  const out = binarize(image((x, y) => (y < 160 ? (inStroke(x, y) ? 250 : 35) : 235)), W, H)
  assert.equal(at(out, 121, 100), 0, 'white letter becomes ink')
  assert.equal(at(out, 135, 100), 255, 'dark band between letters becomes paper')
  assert.equal(at(out, 200, 190), 255, 'light card below stays paper')
})

test('flat noise is not read as ink', () => {
  let seed = 7
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
  const out = binarize(image(() => 200 + Math.round(rnd() * 16 - 8)), W, H)
  assert.equal(out.filter((v) => v === 0).length, 0)
})

test('low-confidence lines are dropped, numbers are kept whatever their confidence', () => {
  const blocks = [{
    paragraphs: [{
      lines: [
        { text: 'SHARMA AUTO ACCESSORIES\n', confidence: 91 },
        { text: '=-- ,| Ee a\n', confidence: 12 },
        { text: 'Mob 98765 43210\n', confidence: 20 },
        { text: '   \n', confidence: 95 },
        { text: 'MG Road, Pune\n', confidence: MIN_LINE_CONFIDENCE },
      ],
    }],
  }]
  assert.equal(textFromBlocks(blocks, 'fallback'), 'SHARMA AUTO ACCESSORIES\nMob 98765 43210\nMG Road, Pune')
})

test('without blocks the plain text is used', () => {
  assert.equal(textFromBlocks(null, 'plain'), 'plain')
  assert.equal(textFromBlocks([], 'plain'), 'plain')
})

test('textAmount counts letters and digits only', () => {
  assert.equal(textAmount('Ab 12 -- ,, |'), 4)
})
