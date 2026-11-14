import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { filterParams, parseFilters, type Filters } from './filters'

const FILTER_KEYS = ['preset', 'from', 'to', 'salesman', 'dealer', 'product', 'category', 'order', 'unit']

/**
 * The report filters and report-specific options (month, idle_days, q, page, compare choices) all live in the URL.
 * Changing a filter keeps the options but goes back to page 1; changing an option keeps the filters.
 */
export function useReportParams() {
  const [params, setParams] = useSearchParams()
  const filters = useMemo(() => parseFilters(params), [params])

  const setFilters = useCallback((patch: Partial<Filters>) => {
    const next = { ...parseFilters(params), ...patch }
    const out = new URLSearchParams()
    for (const [k, v] of params) if (!FILTER_KEYS.includes(k) && k !== 'page') out.set(k, v)
    for (const [k, v] of Object.entries(filterParams(next))) out.set(k, v)
    setParams(out, { replace: true })
  }, [params, setParams])

  /** Set (or clear, with '') one option. Anything but `page` itself sends the report back to page 1. */
  const setParam = useCallback((key: string, value: string) => {
    const out = new URLSearchParams(params)
    if (value) out.set(key, value); else out.delete(key)
    if (key !== 'page') out.delete('page')
    setParams(out, { replace: true })
  }, [params, setParams])

  const setMany = useCallback((patch: Record<string, string>) => {
    const out = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) if (v) out.set(k, v); else out.delete(k)
    out.delete('page')
    setParams(out, { replace: true })
  }, [params, setParams])

  return { params, filters, setFilters, setParam, setMany }
}
