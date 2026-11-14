import { useState } from 'react'
import { Search, UserRoundCheck } from 'lucide-react'
import { Button, qs, useApi, useDebounced } from '../components/ui'
import type { DealerLite } from './types.ts'

/** Search the salesman's own dealers and pick one. Shows the pick as a card with a Change button. */
export default function DealerPicker({ selected, onSelect }: { selected: DealerLite | null; onSelect: (d: DealerLite | null) => void }) {
  const [q, setQ] = useState('')
  const dq = useDebounced(q)
  const { data, loading, error, reload } = useApi<DealerLite[]>(`/api/salesman/dealers/?${qs({ q: dq })}`)

  if (selected) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-primary-line bg-primary-soft p-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-full bg-primary text-white"><UserRoundCheck size={20} aria-hidden /></span>
          <div className="min-w-0">
            <p className="truncate font-semibold text-slate-900">{selected.name}</p>
            <p className="truncate text-xs text-slate-600">{[selected.city, selected.phone].filter(Boolean).join(' · ') || 'Selected dealer'}</p>
          </div>
        </div>
        <Button variant="secondary" size="sm" onClick={() => onSelect(null)}>Change</Button>
      </div>
    )
  }
  return (
    <div className="space-y-3">
      <div className="relative">
        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden />
        <input aria-label="Search dealers" placeholder="Search your dealers by name or phone" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off"
          className="h-10 w-full rounded-lg border bg-white pl-9 pr-3 text-sm" />
      </div>
      {error && (
        <p role="alert" className="flex items-center justify-between gap-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">
          Could not load dealers.<Button size="sm" variant="secondary" onClick={reload}>Try again</Button>
        </p>
      )}
      {loading && !data && <p role="status" className="text-sm text-slate-500">Searching…</p>}
      {data && data.length === 0 && (
        <p className="rounded-lg border border-dashed p-4 text-center text-sm text-slate-500">
          {dq ? 'No dealer of yours matches that.' : 'You have no dealers yet.'} Use Scan Card or Enter Manually to add one.
        </p>
      )}
      {data && data.length > 0 && (
        <ul className={`divide-y overflow-hidden rounded-xl border bg-white ${loading ? 'opacity-60' : ''}`}>
          {data.map((d) => (
            <li key={d.id}>
              <button type="button" onClick={() => onSelect(d)} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-slate-50">
                <span className="min-w-0">
                  <span className="block truncate font-medium text-slate-900">{d.name}</span>
                  <span className="block truncate text-xs text-slate-500">{[d.city, d.phone].filter(Boolean).join(' · ') || 'No location on file'}</span>
                </span>
                <span className="shrink-0 text-xs font-medium text-primary">Select</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
