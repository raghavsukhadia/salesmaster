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
      <PageHeader title="My Dealers" subtitle="Your assigned areas, dealer details and complete order history."
        action={<Button variant="secondary" onClick={() => { areas.reload(); reload() }}>Refresh</Button>} />
      <section aria-label="Assigned areas" className="mb-6">
        <h2 className="mb-3 font-semibold">Assigned areas</h2>
        {areas.loading && !areas.data && <p role="status" className="text-sm text-slate-500">Loading areas...</p>}
        {areas.error && <p role="alert" className="text-sm text-red-700">Could not load areas. Please refresh.</p>}
        {areas.data && areas.data.areas.length === 0 && <Card>No areas or dealers assigned yet.</Card>}
        <div className="flex flex-wrap gap-3">
          {!!areas.data?.areas.length && <Button variant={state ? 'secondary' : 'primary'} onClick={() => choose('')}>All areas ({areas.data.dealers})</Button>}
          {areas.data?.areas.map((a) => (
            <button key={a.key} type="button" aria-pressed={state === a.key} onClick={() => choose(a.key)}
              className={`rounded-xl border px-4 py-3 text-left text-sm ${state === a.key ? 'border-primary bg-primary-soft text-primary' : 'bg-white hover:bg-slate-50'}`}>
              <span className="block font-semibold">{a.label}</span>
              <span className="text-xs">{a.dealers} dealers · {a.orders} orders</span>
              {a.cities.length > 0 && <span className="mt-1 block max-w-64 text-xs text-slate-500">{a.cities.map((c) => c.city).join(', ')}</span>}
            </button>
          ))}
        </div>
      </section>
      <SearchBox value={q} onChange={(v) => { setQ(v); setPage(1) }} placeholder="Search dealer name, mobile or city" />
      {selected && <div className="mb-4 max-w-xs"><Select label="City / area" value={city} onChange={(v) => choose(state, v)}>
        <option value="">All cities in {selected.label}</option>
        {cities.map((c) => <option key={c.city} value={c.city}>{c.city} ({c.dealers})</option>)}
      </Select></div>}
      <Table head={['Dealer', 'Location', 'Status', 'Orders', 'Last visit', 'Details'].map((label) => ({ label }))}
        loading={loading} error={error} empty={data?.results.length === 0}>
        {data?.results.map((d) => (
          <tr key={d.id}>
            <td className="px-3 py-3"><div className="font-semibold">{d.name}</div>{d.shop_name && <div className="text-xs text-slate-500">{d.shop_name}</div>}
              <div className="text-xs text-slate-500">{d.phone || 'No mobile saved'}</div>{!d.mine && <Badge tone="gray">Shared access</Badge>}</td>
            <td className="px-3 text-slate-600">{[d.city, d.state].filter(Boolean).join(', ') || '—'}</td>
            <td className="px-3">{d.status ? <Badge>{d.status}</Badge> : '—'}</td>
            <td className="px-3 tabular-nums">{d.orders}</td>
            <td className="px-3 text-slate-600">{fmtDate(d.last_visit_at, true)}</td>
            <td className="px-3"><Link to={`/my-dealers/${d.id}`} className={buttonClass('secondary', 'sm')} aria-label={`View ${d.name} details and orders`}>View details & orders</Link></td>
          </tr>
        ))}
      </Table>
      <Pager page={page} count={data?.count ?? 0} onChange={setPage} />
    </>
  )
}
