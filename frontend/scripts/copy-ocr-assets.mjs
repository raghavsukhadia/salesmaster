// Copies the OCR engine out of node_modules into public/ocr so card scanning is served from our own origin.
// Nothing is fetched from a CDN at runtime: the card photo is read on the phone and never leaves it.
// Runs automatically before `npm run dev` and `npm run build` (see package.json).
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const nm = join(root, 'node_modules')
const out = join(root, 'public', 'ocr')

// corePath must hold every build the engine may pick between (plain, SIMD, relaxed SIMD) for LSTM-only mode.
const files = [
  [join(nm, 'tesseract.js', 'dist', 'worker.min.js'), join(out, 'worker.min.js')],
  [join(nm, 'tesseract.js-core', 'tesseract-core-lstm.wasm.js'), join(out, 'tesseract-core-lstm.wasm.js')],
  [join(nm, 'tesseract.js-core', 'tesseract-core-simd-lstm.wasm.js'), join(out, 'tesseract-core-simd-lstm.wasm.js')],
  [join(nm, 'tesseract.js-core', 'tesseract-core-relaxedsimd-lstm.wasm.js'), join(out, 'tesseract-core-relaxedsimd-lstm.wasm.js')],
  // "best_int": the accurate model, integer-quantised to about 3 MB.
  [join(nm, '@tesseract.js-data', 'eng', '4.0.0_best_int', 'eng.traineddata.gz'), join(out, 'lang', 'eng.traineddata.gz')],
]

const missing = files.filter(([from]) => !existsSync(from))
if (missing.length) {
  console.error('OCR assets are missing from node_modules. Run `npm install` first:\n' + missing.map(([f]) => '  ' + f).join('\n'))
  process.exit(1)
}

mkdirSync(join(out, 'lang'), { recursive: true })
let copied = 0
for (const [from, to] of files) {
  // Skip files that are already current so repeated dev starts stay instant.
  if (existsSync(to) && statSync(to).size === statSync(from).size) continue
  copyFileSync(from, to)
  copied++
}
console.log(`OCR assets ready in public/ocr (${copied} copied, ${files.length - copied} already current)`)
