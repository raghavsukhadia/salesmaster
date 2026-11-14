// Pure value formatting for report tables, cards and chart labels (kept free of React so it can be unit-tested).
import type { Card, Kind, Row, XKind } from './types.ts'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export const NUMERIC_KINDS: Kind[] = ['int', 'dec', 'pct', 'pct_opt', 'change', 'target', 'rank', 'mixed']
export const isNumeric = (k: Kind) => NUMERIC_KINDS.includes(k)

export const fmtInt = (n: number) => n.toLocaleString('en-IN')
export const fmtDec = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
export const fmtPct = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(1)}%`
/** Signed growth: +12.5% / -3% / 0%. */
export const fmtChange = (n: number) => `${n > 0 ? '+' : ''}${Number.isInteger(n) ? n : n.toFixed(1)}%`

/** 'YYYY-MM-DD' -> '14 Oct 2026' (parsed by hand: `new Date('2026-10-14')` would be UTC and can shift the day). */
export function fmtDay(s: string, short = false): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (!m) return s
  const d = `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}`
  return short ? d : `${d} ${m[1]}`
}

/** 'YYYY-MM' -> 'Oct 2026'. */
export function fmtMonth(s: string, short = false): string {
  const m = /^(\d{4})-(\d{2})$/.exec(s)
  if (!m) return s
  // The short form keeps an apostrophe (Oct '26) so it cannot be read as the 26th of October.
  return short ? `${MONTHS[Number(m[2]) - 1]} '${m[1].slice(2)}` : `${MONTHS[Number(m[2]) - 1]} ${m[1]}`
}

/** 'YYYY-MM-DD HH:MM' (already in local time) -> '14 Oct 2026, 12:05 pm'. */
export function fmtStamp(s: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/.exec(s)
  if (!m) return s
  const h = Number(m[2])
  return `${fmtDay(m[1])}, ${h % 12 || 12}:${m[3]} ${h < 12 ? 'am' : 'pm'}`
}

/** How a chart axis / tooltip names a point, by what the x axis holds. */
export function fmtX(label: string, x: XKind, short = true): string {
  if (x === 'day') return fmtDay(label, short)
  if (x === 'month') return fmtMonth(label, short)
  return label
}

/** The text shown in a table cell. Empty values are an em dash, except where blank is the honest answer. */
export function fmtCell(kind: Kind, v: unknown, row: Row = {}): string {
  const k: Kind = kind === 'mixed' ? ((row.kind as Kind) ?? 'int') : kind
  if (v === null || v === undefined || v === '') return k === 'text' || k === 'badge' ? '' : '—'
  if (typeof v === 'string') {
    if (k === 'date') return fmtDay(v)
    if (k === 'datetime') return fmtStamp(v)
    if (k === 'month') return fmtMonth(v)
    return v
  }
  if (typeof v !== 'number') return String(v)
  switch (k) {
    case 'order': return `#${v}`
    case 'dec': return fmtDec(v)
    case 'pct': case 'pct_opt': return fmtPct(v)
    case 'change': return fmtChange(v)
    case 'target': return v ? fmtInt(v) : 'No target'
    case 'rank': return String(v)
    default: return Number.isInteger(v) ? fmtInt(v) : fmtDec(v)
  }
}

export function fmtCard(c: Card): string {
  const v = c.value
  if (v === null || v === undefined) return '—'
  if (typeof v === 'string') return v
  switch (c.format) {
    case 'pct': return fmtPct(v)
    case 'dec': return fmtDec(v)
    case 'change': return fmtChange(v)
    default: return fmtInt(v)
  }
}

/** Comparison for sorting a column: numbers numerically, text case-insensitively, empty values always last. */
export function compareCells(a: unknown, b: unknown): number {
  const empty = (x: unknown) => x === null || x === undefined || x === ''
  if (empty(a) || empty(b)) return Number(empty(a)) - Number(empty(b))
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b), undefined, { sensitivity: 'base', numeric: true })
}

/** Fill `{key}` placeholders in a link template from a row. */
export function fillPath(template: string, row: Row): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => encodeURIComponent(String(row[k] ?? '')))
}
