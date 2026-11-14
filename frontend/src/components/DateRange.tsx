import { useSearchParams } from 'react-router-dom'
import { CalendarDays, Check, ChevronDown } from 'lucide-react'
import { usePopover } from './usePopover'

export const RANGES = [['today', 'Today'], ['week', 'Last 7 days'], ['month', 'Last 30 days'], ['all', 'All time']] as const
export type Range = (typeof RANGES)[number][0]
const DEFAULT: Range = 'month'

/**
 * The selected date range lives in the URL (?range=week) so a link or a refresh keeps it, and the
 * Dashboard and Visits pages read the same value. The default (30 days) is omitted from the URL.
 */
export function useDateRange(): [Range, (r: Range) => void, string] {
  const [params, setParams] = useSearchParams()
  const raw = params.get('range')
  const range = (RANGES.find(([v]) => v === raw)?.[0] ?? DEFAULT) as Range
  const set = (r: Range) => {
    const next = new URLSearchParams(params)
    if (r === DEFAULT) next.delete('range'); else next.set('range', r)
    setParams(next, { replace: true })
  }
  return [range, set, RANGES.find(([v]) => v === range)![1]]
}

export function DateRangeMenu() {
  const [range, setRange, label] = useDateRange()
  const { open, setOpen, ref } = usePopover()
  return (
    <div ref={ref} className="relative">
      <button type="button" data-trigger aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}
        className="flex h-10 items-center gap-2 rounded-lg border bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50">
        <CalendarDays size={16} className="text-slate-500" aria-hidden />
        <span className="hidden sm:inline">{label}</span>
        <span className="sr-only sm:hidden">Date range: {label}</span>
        <ChevronDown size={14} className="text-slate-400" aria-hidden />
      </button>
      {open && (
        <div role="menu" aria-label="Date range" className="absolute right-0 top-full z-50 mt-2 w-48 rounded-xl border bg-white p-1 shadow-pop">
          {RANGES.map(([v, l]) => (
            <button key={v} type="button" role="menuitemradio" aria-checked={range === v} onClick={() => { setRange(v); setOpen(false) }}
              className={`flex h-9 w-full items-center justify-between rounded-lg px-3 text-sm ${range === v ? 'bg-primary-soft font-medium text-primary' : 'text-slate-700 hover:bg-slate-50'}`}>
              {l}{range === v && <Check size={14} aria-hidden />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
