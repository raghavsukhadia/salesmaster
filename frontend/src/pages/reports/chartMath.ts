// Scales and tick maths for the SVG charts. Pure, so it is tested without a browser.

/** Axis for counts: starts at 0, whole-number steps (1, 2, 5 x 10^n), and the top is a multiple of the step. */
export function niceAxis(max: number, target = 4): { top: number; step: number; ticks: number[] } {
  if (!(max > 0)) return { top: 1, step: 1, ticks: [0, 1] }
  const raw = max / target
  const mag = 10 ** Math.floor(Math.log10(raw))
  const norm = raw / mag
  const step = Math.max(1, (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag)
  const top = Math.ceil(max / step) * step
  const ticks: number[] = []
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(v)
  return { top, step, ticks }
}

/** 950 -> '950', 12 400 -> '12.4K', 3 200 000 -> '3.2M'. Axis labels only; exact values stay in tooltips and tables. */
export function compact(n: number): string {
  const a = Math.abs(n)
  if (a >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`
  if (a >= 10_000) return `${+(n / 1000).toFixed(a >= 100_000 ? 0 : 1)}K`
  return n.toLocaleString('en-IN')
}

/** The indices of `n` x labels to print so none collide: at most one per `minGap` px, always including the last. */
export function labelIndices(n: number, width: number, minGap: number): number[] {
  if (n <= 0) return []
  const fit = Math.max(1, Math.floor(width / minGap))
  if (n <= fit) return Array.from({ length: n }, (_, i) => i)
  const stride = Math.ceil(n / fit)
  const out: number[] = []
  for (let i = n - 1; i >= 0; i -= stride) out.unshift(i) // anchor on the newest point, which matters most
  return out
}

/** Nearest band index for a pointer x inside [left, left + width], clamped. */
export function nearestIndex(x: number, left: number, width: number, n: number): number {
  if (n <= 1) return 0
  const i = Math.round(((x - left) / width) * (n - 1))
  return Math.min(n - 1, Math.max(0, i))
}

/** A column with only its data end (top) rounded; the baseline end stays square. */
export function columnPath(x: number, y: number, w: number, h: number, r = 4): string {
  if (h <= 0) return ''
  const rr = Math.min(r, w / 2, h)
  return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`
}
