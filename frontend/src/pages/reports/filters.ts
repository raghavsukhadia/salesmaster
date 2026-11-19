/** The report filters live in the URL, so a link, a refresh and the Excel / PDF export all see the same selection. */

export const PRESETS = [
  ['today', 'Today'], ['yesterday', 'Yesterday'], ['last7', 'Last 7 days'], ['last30', 'Last 30 days'], ['this_month', 'This month'],
  ['last_month', 'Last month'], ['this_year', 'This year'], ['custom', 'Custom range'], ['all', 'All time'],
] as const
export type Preset = (typeof PRESETS)[number][0]
export const DEFAULT_PRESET: Preset = 'last30'

export interface Filters {
  preset: Preset
  from: string
  to: string
  salesman: string
  dealer: string
  product: string
  category: string
  order: string
  unit: string
}

export const EMPTY_FILTERS: Filters = { preset: DEFAULT_PRESET, from: '', to: '', salesman: '', dealer: '', product: '', category: '', order: '', unit: '' }

const DAY = /^\d{4}-\d{2}-\d{2}$/
const isPreset = (v: string | null): v is Preset => PRESETS.some(([p]) => p === v)

export function parseFilters(p: URLSearchParams): Filters {
  const preset = p.get('preset')
  return {
    preset: isPreset(preset) ? preset : DEFAULT_PRESET,
    from: DAY.test(p.get('from') ?? '') ? p.get('from')! : '',
    to: DAY.test(p.get('to') ?? '') ? p.get('to')! : '',
    salesman: /^\d+$/.test(p.get('salesman') ?? '') ? p.get('salesman')! : '',
    dealer: /^\d+$/.test(p.get('dealer') ?? '') ? p.get('dealer')! : '',
    product: p.get('product') ?? '',
    category: p.get('category') ?? '',
    order: /^\d+$/.test(p.get('order') ?? '') ? p.get('order')! : '',
    unit: /^[A-Za-z ]{1,10}$/.test(p.get('unit') ?? '') ? p.get('unit')! : '',
  }
}

/** The non-default filters as URL params. The default period and empty filters are left out to keep links short. */
export function filterParams(f: Filters): Record<string, string> {
  const out: Record<string, string> = {}
  if (f.preset !== DEFAULT_PRESET) out.preset = f.preset
  if (f.preset === 'custom') {
    if (f.from) out.from = f.from
    if (f.to) out.to = f.to
  }
  for (const k of ['salesman', 'dealer', 'product', 'category', 'order', 'unit'] as const) if (f[k]) out[k] = f[k]
  return out
}

/** A custom range is only usable once it has a start, and the end must not come before it. */
export function customRangeError(f: Filters): string {
  if (f.preset !== 'custom') return ''
  if (!f.from) return 'Choose a start date'
  if (f.to && f.to < f.from) return 'The end date is before the start date'
  return ''
}

/** How many filters are set, counting a non-default period. Drives the badge on the mobile Filters button. */
export function activeCount(f: Filters): number {
  return Object.keys(filterParams(f)).filter((k) => k !== 'from' && k !== 'to').length
}

/** `?preset=all&salesman=3` for the filters only, or '' when none are set. Used for links between reports. */
export function filterSearch(f: Filters): string {
  const q = new URLSearchParams(filterParams(f)).toString()
  return q ? `?${q}` : ''
}

export const COMPARE_KINDS = [
  ['salesman', 'Two salesman'], ['product', 'Two products'], ['dealer', 'Two dealers'], ['month', 'Two months'], ['range', 'Two date ranges'],
] as const
export type CompareKind = (typeof COMPARE_KINDS)[number][0]

/** Is `v` a complete, sensible choice for one side of a comparison of this kind? */
export function validCompareValue(kind: string, v: string): boolean {
  switch (kind) {
    case 'salesman': case 'dealer': return /^\d{1,12}$/.test(v)
    case 'product': return /^(p\d{1,12}|n:.+)$/.test(v)
    case 'month': return /^\d{4}-(0[1-9]|1[0-2])$/.test(v)
    case 'range': {
      const m = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(v)
      return !!m && m[1] <= m[2]
    }
    default: return false
  }
}
