import { useEffect, useState } from 'react'
import { ListFilter, RotateCcw, Search } from 'lucide-react'
import { Button, DropdownSelect, useDebounced } from '../../components/ui'
import DealerPicker from './DealerPicker'
import SearchSelect from './SearchSelect'
import { activeCount, customRangeError, EMPTY_FILTERS, PRESETS, type Filters, type Preset } from './filters'
import type { FilterOptions } from './types'

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d) }

interface Props {
  filters: Filters
  options: FilterOptions | null
  setFilters: (patch: Partial<Filters>) => void
}

/** One row above every report. All of these filters apply together and scope every chart, ranking, table and total below. */
export default function FilterBar({ filters, options, setFilters }: Props) {
  const [more, setMore] = useState(false)
  const management = options?.management ?? true
  const count = activeCount(filters)

  // Custom dates are held as a draft and only applied once they form a valid range, so the report never loads a half-typed range.
  const [draft, setDraft] = useState({ from: filters.from, to: filters.to })
  const draftFilters = { ...filters, ...draft }
  const rangeError = filters.preset === 'custom' ? customRangeError(draftFilters) : ''
  const commit = (next: { from: string; to: string }) => {
    setDraft(next)
    if (!customRangeError({ ...filters, ...next })) setFilters(next)
  }
  const choosePreset = (p: string) => {
    if (p === 'custom') {
      const next = { from: draft.from || daysAgo(29), to: draft.to || daysAgo(0) }
      setDraft(next)
      setFilters({ preset: 'custom', ...next })
    } else setFilters({ preset: p as Preset })
  }

  // Order ID: digits only, applied after a short pause.
  const [order, setOrder] = useState(filters.order)
  const debouncedOrder = useDebounced(order, 400)
  // Only once typing has settled (debounced === typed), so Reset can never be undone by a stale value.
  useEffect(() => { if (debouncedOrder === order && order !== filters.order) setFilters({ order }) }, [debouncedOrder, order, filters.order, setFilters])
  const reset = () => { setOrder(''); setDraft({ from: '', to: '' }); setFilters(EMPTY_FILTERS) }

  const field = 'h-10 w-full rounded-lg border bg-white px-3 text-sm font-normal text-slate-900'

  return (
    <section aria-label="Report filters" className="mb-6 rounded-xl border bg-white p-3 shadow-card print:hidden [&_label]:font-semibold [&_label]:text-slate-800">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-44">
          <DropdownSelect label="Period" value={filters.preset} onChange={choosePreset} options={PRESETS.map(([value, label]) => ({ value, label }))} />
        </div>
        {filters.preset === 'custom' && (
          <>
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">From
              <input type="date" value={draft.from} max={draft.to || undefined} onChange={(e) => commit({ ...draft, from: e.target.value })} className={`${field} w-40`} aria-invalid={!!rangeError || undefined} />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">To
              <input type="date" value={draft.to} min={draft.from || undefined} onChange={(e) => commit({ ...draft, to: e.target.value })} className={`${field} w-40`} aria-invalid={!!rangeError || undefined} />
            </label>
          </>
        )}
        <div className="ml-auto flex items-center gap-2 lg:hidden">
          <Button variant="secondary" aria-expanded={more} aria-controls="more-filters" onClick={() => setMore(!more)}>
            <ListFilter size={16} aria-hidden />Filters{count ? ` (${count})` : ''}
          </Button>
        </div>
        {count > 0 && (
          <Button variant="ghost" onClick={reset} className="lg:ml-auto"><RotateCcw size={15} aria-hidden />Reset</Button>
        )}
      </div>
      {rangeError && <p role="alert" className="mt-2 text-xs text-red-600">{rangeError}</p>}

      <div id="more-filters" className={`${more ? 'grid' : 'hidden'} mt-3 gap-3 sm:grid-cols-2 lg:grid lg:grid-cols-6`}>
        {management && (
          <DropdownSelect label="Salesman" value={filters.salesman} onChange={(v) => setFilters({ salesman: v })}
            options={[{ value: '', label: 'All salesman' }, ...(options?.salesmen ?? []).map((s) => ({ value: String(s.id), label: s.active ? s.name : `${s.name} (inactive)` }))]} />
        )}
        <DealerPicker label="Dealer" value={filters.dealer} onChange={(v) => setFilters({ dealer: v })} />
        <SearchSelect label="Product name" value={filters.product} allLabel="All products" placeholder="Search products"
          options={(options?.products ?? []).map((p) => ({ value: p.value, label: p.label, hint: p.custom ? 'Custom item' : p.category }))}
          onChange={(v) => setFilters({ product: v })} />
        <DropdownSelect label="Product category" value={filters.category} onChange={(v) => setFilters({ category: v })}
          options={[{ value: '', label: 'All categories' }, ...(options?.categories ?? []).map((c) => ({ value: c, label: c }))]} />
        <DropdownSelect label="Unit" value={filters.unit} onChange={(v) => setFilters({ unit: v })}
          options={[{ value: '', label: 'All units' }, ...(options?.units ?? []).map((u) => ({ value: u, label: u }))]} />
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">Order ID
          <span className="relative block">
            <Search size={15} aria-hidden className="pointer-events-none absolute left-3 top-3 text-slate-400" />
            <input value={order} onChange={(e) => setOrder(e.target.value.replace(/\D/g, '').slice(0, 12))} inputMode="numeric" placeholder="e.g. 128" className={`${field} pl-9`} />
          </span>
        </label>
      </div>
      {filters.order && <p className="mt-2 text-xs text-slate-500">While an Order ID is set, the period is ignored so the order is always found.</p>}
    </section>
  )
}
