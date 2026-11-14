import { useEffect, useState } from 'react'
import { api, ApiError } from '../auth'
import { flatten, useDebounced } from './ui'

export type Mode = 'owner_state' | 'owner_city' | 'dealer'
export interface Options {
  salesmen: { id: number; name: string; active: boolean }[]
  states: string[]
  cities: { state: string; city: string }[]
  reasons: { value: string; label: string }[]
  access_types: { value: string; label: string }[]
}
export interface DealerHit { id: number; name: string; location: string; owner: string | null }
export interface Scope { mode: Mode; owner: string; state: string; city: string; dealer: DealerHit | null }
export const EMPTY_SCOPE: Scope = { mode: 'owner_state', owner: '', state: '', city: '', dealer: null }

export const field = 'w-full rounded-lg border bg-white px-3 py-2.5 text-sm font-normal text-slate-900 disabled:bg-slate-50 disabled:text-slate-400'
export const errText = (e: unknown) => (e instanceof ApiError ? flatten(e.data).join(' · ') || 'Request failed' : 'Network error. Please try again.')

export function scopeBody(s: Scope) {
  if (s.mode === 'dealer') return { mode: s.mode, dealer_id: s.dealer?.id }
  return { mode: s.mode, owner_id: s.owner ? Number(s.owner) : undefined, state: s.mode === 'owner_state' ? s.state : '', city: s.mode === 'owner_city' ? s.city : '' }
}

export const scopeReady = (s: Scope) =>
  s.mode === 'dealer' ? !!s.dealer : !!s.owner && (s.mode === 'owner_state' ? !!s.state : !!s.city)

const MODES: [Mode, string][] = [['owner_state', 'Owner + State'], ['owner_city', 'Owner + City'], ['dealer', 'Specific Dealer']]

export function ModePills({ value, onChange, disabled }: { value: Mode; onChange: (m: Mode) => void; disabled?: boolean }) {
  return (
    <div className="mb-5 flex gap-2" role="group" aria-label="Scope">
      {MODES.map(([m, l]) => (
        <button key={m} type="button" disabled={disabled} aria-pressed={value === m} onClick={() => onChange(m)}
          className={`rounded-lg border px-3 py-1.5 text-sm font-medium disabled:opacity-60 ${value === m ? 'border-primary bg-primary hover:bg-primary-hover text-white' : 'bg-white hover:bg-slate-50'}`}>{l}</button>
      ))}
    </div>
  )
}

export function Label({ text, children }: { text: string; children: React.ReactNode }) {
  return <label className="flex flex-col gap-2 text-sm font-medium">{text}{children}</label>
}

function DealerPicker({ value, onChange, disabled }: { value: DealerHit | null; onChange: (d: DealerHit | null) => void; disabled?: boolean }) {
  const [q, setQ] = useState('')
  const dq = useDebounced(q.trim())
  const [hits, setHits] = useState<DealerHit[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (dq.length < 2) return setHits([])
    let live = true
    setLoading(true)
    api<{ results: DealerHit[] }>(`/api/management/dealers/?q=${encodeURIComponent(dq)}`)
      .then((r) => live && setHits(r.results))
      .catch(() => live && setHits([]))
      .finally(() => live && setLoading(false))
    return () => { live = false }
  }, [dq])

  if (value) {
    return (
      <div className="flex items-center justify-between rounded-lg border bg-slate-50 px-3 py-2.5 text-sm">
        <span><b>{value.name}</b> <span className="text-slate-500">· {value.location || 'No location'} · {value.owner ? `Owner: ${value.owner}` : 'Unassigned'}</span></span>
        <button type="button" disabled={disabled} onClick={() => onChange(null)} className="text-primary hover:underline">Change</button>
      </div>
    )
  }
  return (
    <div className="relative">
      <input value={q} disabled={disabled} onChange={(e) => setQ(e.target.value)} placeholder="Search a dealer by name, phone or city…" aria-label="Search dealer" className={field} />
      {dq.length >= 2 && (
        <ul className="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-lg border bg-white shadow-md">
          {loading && <li className="p-3 text-sm text-slate-500">Searching…</li>}
          {!loading && hits.length === 0 && <li className="p-3 text-sm text-slate-500">No dealers found.</li>}
          {hits.map((d) => (
            <li key={d.id}><button type="button" onClick={() => onChange(d)} className="block w-full px-3 py-2 text-left text-sm hover:bg-slate-50">
              <b>{d.name}</b> <span className="text-slate-500">· {d.location || 'No location'} · {d.owner ? `Owner: ${d.owner}` : 'Unassigned'}</span>
            </button></li>
          ))}
        </ul>
      )}
    </div>
  )
}

// Renders grid cells; place it inside a two-column grid.
export function ScopeFields({ scope, onChange, options, ownerLabel, disabled }: {
  scope: Scope; onChange: (s: Scope) => void; options: Options | null; ownerLabel: string; disabled?: boolean
}) {
  const set = (p: Partial<Scope>) => onChange({ ...scope, ...p })
  if (scope.mode === 'dealer') {
    return (
      <div className="col-span-2"><Label text="Dealer"><DealerPicker value={scope.dealer} onChange={(dealer) => set({ dealer })} disabled={disabled} /></Label></div>
    )
  }
  const cities = [...new Set((options?.cities ?? []).map((c) => c.city))].sort()
  return (
    <>
      <Label text={ownerLabel}>
        <select value={scope.owner} disabled={disabled} onChange={(e) => set({ owner: e.target.value })} className={field}>
          <option value="">Select the current owner</option>
          {options?.salesmen.map((s) => <option key={s.id} value={s.id}>{s.name}{s.active ? '' : ' (inactive)'}</option>)}
        </select>
      </Label>
      {scope.mode === 'owner_state' ? (
        <Label text="State">
          <select value={scope.state} disabled={disabled} onChange={(e) => set({ state: e.target.value })} className={field}>
            <option value="">Select a state</option>
            {options?.states.map((s) => <option key={s}>{s}</option>)}
          </select>
        </Label>
      ) : (
        <Label text="City">
          <select value={scope.city} disabled={disabled} onChange={(e) => set({ city: e.target.value })} className={field}>
            <option value="">Select a city</option>
            {cities.map((c) => <option key={c}>{c}</option>)}
          </select>
        </Label>
      )}
    </>
  )
}

export function PreviewBox({ dealers, sample, extra, noun = 'dealer' }: { dealers: number; sample: { id: number; name: string; city: string; state: string }[]; extra?: React.ReactNode; noun?: string }) {
  return (
    <div role="status" className="mt-5 whitespace-normal rounded-xl border border-primary-line bg-primary-soft p-4 text-sm">
      <p className="font-medium text-primary">{dealers} {noun}{dealers === 1 ? '' : 's'} affected{extra}</p>
      {sample.length > 0 && (
        <ul className="mt-2 list-inside list-disc text-slate-700">
          {sample.map((d) => <li key={d.id}>{d.name}{d.city || d.state ? <span className="text-slate-500"> — {[d.city, d.state].filter(Boolean).join(', ')}</span> : null}</li>)}
          {dealers > sample.length && <li className="list-none text-slate-500">…and {dealers - sample.length} more</li>}
        </ul>
      )}
    </div>
  )
}

export function AdminNotice() {
  return <p role="note" className="mb-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">You have view-only access here. Only admins can make changes.</p>
}
