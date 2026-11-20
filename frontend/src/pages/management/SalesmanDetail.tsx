import { useEffect, useState } from 'react'
import { Link, useLocation, useOutletContext, useParams } from 'react-router-dom'
import { api, type Me } from '../../auth'
import { Badge, fmtDate, fmtTime, Pager, Pills, SearchBox, StatStrip, Table, useApi, useDebounced, qs } from '../../components/ui'
import { errText } from './Salesmen'

interface Pct { visits: number; target: number; percent: number | null }
interface Detail {
  id: number; username: string; first_name: string; last_name: string; name: string; email: string; phone: string; active: boolean
  targets: { daily_visits: number; monthly_visits: number; monthly_orders: number }
  territories: { state: string; city: string }[]
  performance: {
    today: Pct
    month: { visits: number; visit_target: number; visit_percent: number | null; orders: number; order_target: number; order_percent: number | null; new_dealers: number }
    dealers_owned: number
    followups: { pending: number; overdue: number; completed_this_month: number }
    last_visit_at: string | null; days_since_last_visit: number | null
  }
}
interface VisitRow { id: number; visited_at: string; dealer: string; location: string; products: string[]; has_order: boolean; followup_due: string | null }
interface DealerRow { id: number; name: string; phone: string; location: string; status: string; last_visit_at: string | null }
interface DealerHit { id: number; name: string; location: string; owner: string | null }

const card = 'mb-6 rounded-2xl border bg-white p-5'
const input = 'w-full rounded-lg border px-3 py-2 text-sm'
const primary = 'rounded-lg bg-primary hover:bg-primary-hover px-4 py-2 text-sm font-medium text-white disabled:opacity-50'
const outline = 'rounded-lg border px-3 py-2 text-sm hover:bg-slate-50 disabled:opacity-50'
const Err = ({ text }: { text: string }) => (text ? <p role="alert" className="mb-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">{text}</p> : null)
const Ok = ({ text }: { text: string }) => (text ? <p role="status" className="mb-3 rounded-lg bg-green-50 p-3 text-sm text-green-700">{text}</p> : null)

function useAction(reload: () => void) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [ok, setOk] = useState('')
  async function run(fn: () => Promise<unknown>, msg: string) {
    if (busy) return
    setBusy(true)
    setErr('')
    setOk('')
    try {
      await fn()
      setOk(msg)
      reload()
    } catch (x) {
      setErr(errText(x))
    } finally {
      setBusy(false)
    }
  }
  return { busy, err, ok, run }
}

function AssignDealers({ d, reload, version }: { d: Detail; reload: () => void; version: number }) {
  const [q, setQ] = useState('')
  const dq = useDebounced(q)
  const [picked, setPicked] = useState<Record<number, string>>({})
  const [reason, setReason] = useState('')
  const [page, setPage] = useState(1)
  useEffect(() => setPage(1), [dq, version])
  const hits = useApi<{ count: number; results: DealerHit[] }>(`/api/management/dealers/?${qs({ q: dq.trim() || undefined, archive: 'active', sort: 'name', not_owner: d.id, page, _: version })}`)
  const { busy, err, ok, run } = useAction(reload)
  const ids = Object.keys(picked).map(Number)
  return (
    <section id="assign" className={card}>
      <h2 className="mb-1 font-semibold">Assign or transfer dealers</h2>
      <p className="mb-3 text-xs text-slate-500">Selected dealers become owned by {d.name}. Dealers they already own are not listed. Previous ownership is kept in history.</p>
      <Err text={err} /><Ok text={ok} />
      <div className="mb-3 max-w-sm"><SearchBox value={q} onChange={setQ} placeholder="Search dealers by name, phone or city" /></div>
      <ul className="max-h-[28rem] divide-y overflow-auto rounded-lg border">
        {hits.loading && <li className="p-3 text-sm text-slate-500">Loading…</li>}
        {hits.data?.results.length === 0 && <li className="p-3 text-sm text-slate-500">No dealers found</li>}
        {hits.data?.results.map((h) => (
          <li key={h.id}>
            <label className="flex cursor-pointer items-center gap-3 p-3 text-sm">
              <input type="checkbox" checked={h.id in picked} onChange={(e) => { const n = { ...picked }; if (e.target.checked) n[h.id] = h.name; else delete n[h.id]; setPicked(n) }} />
              <span className="font-medium">{h.name}</span><span className="text-slate-500">{h.location}</span>
              <span className="ml-auto text-xs text-slate-500">{h.owner ? `Owner: ${h.owner}` : 'Unassigned'}</span>
            </label>
          </li>
        ))}
      </ul>
      <Pager page={page} count={hits.data?.count ?? 0} onChange={setPage} />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input className={`${input} max-w-xs`} placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
        <button disabled={busy || !d.active || ids.length === 0} className={primary}
          onClick={() => run(async () => { await api(`/api/management/salesmen/${d.id}/assign-dealers/`, { method: 'POST', body: { dealer_ids: ids, reason } }); setPicked({}) }, `Assigned ${ids.length} dealer(s)`)}>
          {busy ? 'Assigning…' : `Assign ${ids.length || ''} selected`}
        </button>
        {!d.active && <span className="text-xs text-amber-700">Activate this salesman first</span>}
      </div>
    </section>
  )
}

function Tabs({ id, version }: { id: number; version: number }) {
  const [tab, setTab] = useState<'visits' | 'dealers'>('visits')
  const [page, setPage] = useState(1)
  useEffect(() => setPage(1), [tab])
  const v = useApi<{ count: number; results: VisitRow[] }>(`/api/management/salesmen/${id}/visits/?page=${page}&_=${version}`)
  const d = useApi<{ count: number; results: DealerRow[] }>(`/api/management/salesmen/${id}/dealers/?page=${page}&_=${version}`)
  const cur = tab === 'visits' ? v : d
  return (
    <section className="mb-6">
      <div className="mb-3"><Pills value={tab} onChange={setTab} options={[['visits', 'Visit history'], ['dealers', 'Owned dealers']]} /></div>
      {tab === 'visits' ? (
        <Table stack head={[{ label: 'When' }, { label: 'Dealer' }, { label: 'Location' }, { label: 'Order' }, { label: 'Follow-up' }]} loading={v.loading} error={v.error} empty={v.data?.count === 0}>
          {v.data?.results.map((r) => (
            <tr key={r.id}>
              <td className="px-4 py-4">{fmtDate(r.visited_at)} {fmtTime(r.visited_at)}</td><td className="px-4">{r.dealer}</td><td className="px-4">{r.location || '—'}</td>
              <td className="px-4">{r.has_order ? r.products.join(', ') : 'No order'}</td><td className="px-4">{fmtDate(r.followup_due) || '—'}</td>
            </tr>
          ))}
        </Table>
      ) : (
        <Table stack head={[{ label: 'Dealer' }, { label: 'Phone' }, { label: 'Location' }, { label: 'Status' }, { label: 'Last visit' }]} loading={d.loading} error={d.error} empty={d.data?.count === 0}>
          {d.data?.results.map((r) => (
            <tr key={r.id}>
              <td className="px-4 py-4"><Link to={`/dealers/${r.id}`} className="text-primary hover:underline">{r.name}</Link></td><td className="px-4">{r.phone}</td>
              <td className="px-4">{r.location || '—'}</td><td className="px-4">{r.status || '—'}</td><td className="px-4">{fmtDate(r.last_visit_at) || 'Never'}</td>
            </tr>
          ))}
        </Table>
      )}
      <Pager page={page} count={cur.data?.count ?? 0} onChange={setPage} />
    </section>
  )
}

export default function SalesmanDetail() {
  const { id } = useParams()
  const { me } = useOutletContext<{ me: Me }>()
  const { hash } = useLocation()
  const [n, setN] = useState(0)
  const { data: d, loading, error } = useApi<Detail>(`/api/management/salesmen/${id}/?_=${n}`)
  const admin = me.role === 'admin'
  const [toggling, setToggling] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => { if (d && hash) document.getElementById(hash.slice(1))?.scrollIntoView() }, [d?.id, hash])

  if (loading && !d) return <p className="text-slate-500">Loading…</p>
  if (error || !d) return <div><Link to="/salesmen" className="text-primary hover:underline">← Back to Salesman</Link><p role="alert" className="mt-3 text-red-700">Salesman not found or could not be loaded.</p></div>

  const p = d.performance
  async function toggle() {
    if (toggling || !d) return
    setToggling(true)
    setErr('')
    try {
      await api(`/api/management/salesmen/${d.id}/`, { method: 'PATCH', body: { is_active: !d.active } })
      setN((v) => v + 1)
    } catch (x) {
      setErr(errText(x))
    } finally {
      setToggling(false)
    }
  }

  return (
    <>
      <Link to="/salesmen" className="mb-2 inline-block text-sm text-primary hover:underline">← Salesman</Link>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{d.name}</h1>
        <Badge tone={d.active ? 'green' : 'gray'}>{d.active ? 'Active' : 'Inactive'}</Badge>
        <span className="text-sm text-slate-500">@{d.username} · {d.phone}</span>
        <button disabled={toggling} onClick={toggle} className={`${outline} ml-auto`}>{d.active ? 'Deactivate' : 'Activate'}</button>
      </div>
      <Err text={err} />
      <div className="mb-6">
        <StatStrip items={[
          { label: 'Visits today', value: p.today.target ? `${p.today.visits} / ${p.today.target}` : p.today.visits },
          { label: 'Visits this month', value: p.month.visit_target ? `${p.month.visits} / ${p.month.visit_target}` : p.month.visits },
          { label: 'Orders this month', value: p.month.order_target ? `${p.month.orders} / ${p.month.order_target}` : p.month.orders },
          { label: 'Dealers owned', value: p.dealers_owned },
          { label: 'Overdue follow-ups', value: p.followups.overdue, tone: p.followups.overdue ? 'red' : undefined },
        ]} />
        <p className="mt-2 text-xs text-slate-500">
          New dealers {p.month.new_dealers} ·
          Pending follow-ups {p.followups.pending} · Last visit {p.last_visit_at ? `${fmtDate(p.last_visit_at)} (${p.days_since_last_visit}d ago)` : 'never'}
        </p>
      </div>
      <Tabs id={d.id} version={n} />
      {admin && <AssignDealers d={d} version={n} reload={() => setN((v) => v + 1)} />}
    </>
  )
}
