import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Badge, Button, buttonClass, Card, fmtDate, PageHeader, Pager, qs, SearchBox, Select, Table, useApi, useDebounced } from '../components/ui'

interface Area {
  key: string; label: string; state: string; dealers: number; orders: number
  cities: { city: string; dealers: number }[]
}
interface Dealer {
  id: number; name: string; shop_name: string; phone: string; city: string; state: string
  status: string; orders: number; last_visit_at: string | null; mine: boolean
}

const areaChip = (on: boolean) =>
  `min-w-0 rounded-xl border px-4 py-3 text-left text-sm transition-colors sm:w-52 ${on ? 'border-primary bg-primary text-white shadow-sm' : 'bg-white text-slate-900 hover:bg-slate-50'}`

export default function MyDealers() {
  const [params, setParams] = useSearchParams()
  const state = params.get('state') ?? ''
  const city = params.get('city') ?? ''
  const [q, setQ] = useState('')
  const dq = useDebounced(q)
  const [page, setPage] = useState(1)
  const areas = useApi<{ areas: Area[]; dealers: number }>('/api/salesman/areas/')
  const { data, loading, error, reload } = useApi<{ count: number; results: Dealer[] }>(
    `/api/salesman/dealer-list/?${qs({ state, city, q: dq, page })}`,
  )
  const selected = areas.data?.areas.find((a) => a.key === state)
  const cities = selected?.cities ?? []
  const choose = (nextState: string, nextCity = '') => {
    setParams(qs({ state: nextState, city: nextCity }))
    setPage(1)
  }

  return (
    <>
      <PageHeader title="My Dealers" inlineAction
        action={<Button variant="secondary" size="sm" onClick={() => { areas.reload(); reload() }}>Refresh</Button>} />
      <section aria-label="Assigned areas" className="mb-6">
        <h2 className="mb-3 font-semibold">Assigned areas</h2>
        {areas.loading && !areas.data && <p role="status" className="text-sm text-slate-500">Loading areas...</p>}
        {areas.error && <p role="alert" className="text-sm text-red-700">Could not load areas. Please refresh.</p>}
        {areas.data && areas.data.areas.length === 0 && <Card className="px-4 py-3 text-sm text-slate-600">No areas or dealers assigned yet.</Card>}
        {/* Every chip, "All areas" included, is the same card so they line up: two per row on phones, wrapping on wider screens. */}
        <div className="grid grid-cols-2 gap-3 sm:flex sm:flex-wrap">
          {!!areas.data?.areas.length && (
            <button type="button" aria-pressed={!state} onClick={() => choose('')} className={areaChip(!state)}>
              <span className="block truncate font-semibold">All areas</span>
              <span className={`text-xs ${!state ? 'text-white/85' : 'text-slate-600'}`}>{areas.data.dealers} {areas.data.dealers === 1 ? 'dealer' : 'dealers'}</span>
            </button>
          )}
          {areas.data?.areas.map((a) => (
            <button key={a.key} type="button" aria-pressed={state === a.key} onClick={() => choose(a.key)} className={areaChip(state === a.key)}>
              <span className="block truncate font-semibold">{a.label}</span>
              <span className={`block text-xs ${state === a.key ? 'text-white/85' : 'text-slate-600'}`}>{a.dealers} {a.dealers === 1 ? 'dealer' : 'dealers'} · {a.orders} {a.orders === 1 ? 'order' : 'orders'}</span>
              {a.cities.length > 0 && <span className={`mt-1 block truncate text-xs ${state === a.key ? 'text-white/70' : 'text-slate-500'}`}>{a.cities.map((c) => c.city).join(', ')}</span>}
            </button>
          ))}
        </div>
      </section>
      <SearchBox value={q} onChange={(v) => { setQ(v); setPage(1) }} placeholder="Search dealer name, mobile or city" />
      {selected && <div className="mb-4 max-w-xs"><Select label="City / area" value={city} onChange={(v) => choose(state, v)}>
        <option value="">All cities in {selected.label}</option>
        {cities.map((c) => <option key={c.city} value={c.city}>{c.city} ({c.dealers})</option>)}
      </Select></div>}
      <Table stack head={['Dealer', 'Location', 'Status', 'Orders', 'Last visit', 'Details'].map((label) => ({ label }))}
        loading={loading} error={error} empty={data?.results.length === 0}>
        {data?.results.map((d) => (
          <tr key={d.id}>
            <td className="px-3 py-3"><div className="font-semibold">{d.name}</div>{d.shop_name && <div className="text-xs text-slate-500">{d.shop_name}</div>}
              <div className="text-xs text-slate-500">{d.phone || 'No mobile saved'}</div>{!d.mine && <Badge tone="gray">Shared access</Badge>}</td>
            <td className="px-3 text-slate-600">{[d.city, d.state].filter(Boolean).join(', ') || '—'}</td>
            <td className="px-3">{d.status ? <Badge>{d.status}</Badge> : '—'}</td>
            <td className="px-3 tabular-nums">{d.orders}</td>
            <td className="px-3 text-slate-600">{fmtDate(d.last_visit_at, true)}</td>
            <td className="px-3" data-label=""><Link to={`/my-dealers/${d.id}`} className={buttonClass('secondary', 'sm', 'max-sm:h-10 max-sm:w-full')} aria-label={`View ${d.name} details and orders`}>View details & orders</Link></td>
          </tr>
        ))}
      </Table>
      <Pager page={page} count={data?.count ?? 0} onChange={setPage} />
    </>
  )
}
