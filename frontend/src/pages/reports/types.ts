// The shape of what /api/reports/* returns. One payload type serves every report, so one renderer can show them all.

export type Kind =
  | 'text' | 'int' | 'dec' | 'pct' | 'pct_opt' | 'date' | 'datetime' | 'month' | 'order' | 'rank' | 'badge' | 'change' | 'target' | 'mixed'
export type XKind = 'day' | 'month' | 'year' | 'text'
export type Row = Record<string, unknown>

export interface Link { path: string; search?: string }

export interface Card {
  key: string
  label: string
  value: number | string | null
  format: 'int' | 'pct' | 'dec' | 'text' | 'change'
  hint: string
}

export interface Col { key: string; label: string; kind: Kind; link?: Link }

export interface Tbl {
  id: string
  title: string
  subtitle: string
  columns: Col[]
  rows: Row[]
  /** All rows that match, which can be more than `rows` (screen cap, or the current server page). */
  total: number
  totals: Row | null
  compact: boolean
  search: boolean
  /** Search and paging happen on the server (the order list), driven by the `q` and `page` URL params. */
  server?: boolean
  page?: number
  page_size?: number
}

export interface Series { key: string; label: string }

export interface Chart {
  id: string
  title: string
  subtitle: string
  type: 'line' | 'column' | 'hbar' | 'segments' | 'compare'
  series: Series[]
  points: Row[]
  /** Can be switched between quantity and orders on screen. */
  measurable: boolean
  note: string
  x: XKind
}

export interface RankRow { rank: number; id: number | string; name: string; value: number; note: string }
export interface Ranking { id: string; title: string; unit: string; format: 'int' | 'pct'; link: Link; rows: RankRow[] }

export interface ReportOption {
  key: string
  label: string
  type: 'choice' | 'month'
  value: string | number
  choices?: [string, string][]
}

export interface Report {
  report: string
  title: string
  meta: {
    range: { preset: string; from: string; to: string; label: string }
    filters: { label: string; value: string }[]
    scope: 'company' | 'own'
    generated_at: string
    /** The units the matching order lines use. */
    units: string[]
    /** The one unit in use, 'mixed' when quantities are in several units, '' when the report shows no quantities. */
    unit: string
  }
  cards: Card[]
  charts: Chart[]
  tables: Tbl[]
  rankings: Ranking[]
  options: ReportOption[]
  notes: string[]
  /** Things that make the numbers easy to misread, e.g. quantities in different units added together. */
  warnings: string[]
}

export interface FilterOptions {
  role: string
  management: boolean
  salesmen: { id: number; name: string; active: boolean }[]
  categories: string[]
  products: { value: string; label: string; category: string; custom: boolean }[]
  units: string[]
  months: string[]
}

/** What every report screen gets from the layout through the router's outlet context. */
export interface ReportCtx { me: { id: number; username: string; role: string }; options: FilterOptions | null }

export const MEASURES = [['qty', 'Quantity'], ['orders', 'Orders']] as const
export type Measure = (typeof MEASURES)[number][0]

/** True when the chart has something to draw for the chosen measure. Empty charts are not shown at all. */
export function chartHasData(chart: Chart, measure: Measure): boolean {
  const keys = chart.measurable ? [measure] : chart.series.map((s) => s.key)
  const has = (p: Row, k: string) => typeof p[k] === 'number' && (p[k] as number) > 0
  return chart.points.some((p) => keys.some((k) => has(p, k)) || (chart.type === 'segments' && has(p, 'value')))
}
