import { useState } from 'react'
import { Link, useOutletContext, useParams } from 'react-router-dom'
import { api, ApiError, type Me } from '../../auth'
import { Badge, fmtDate, fmtTime, flatten, PageHeader, Pager, Pills, StateSelect, StatStrip, Table, useApi } from '../../components/ui'

interface Profile {
  id: number; name: string; shop_name: string; phone: string; whatsapp: string; address: string; city: string; state: string
  pincode: string; gst_number: string; status: string; distributor: string; is_archived: boolean
  last_visit_at: string | null; next_followup: string | null; created_at: string
}
interface Detail {
  profile: Profile
  contacts: { id: number; name: string; designation: string; phone: string; whatsapp: string; email: string }[]
  stats: { visits: number; orders: number; pending_followups: number; overdue_followups: number }
  permissions: { can_edit: boolean; can_transfer: boolean; can_manage_access: boolean }
  owner?: { id: number; name: string; since: string } | null
  ownership_history?: { id: number; salesman: string; started_at: string; ended_at: string | null; reason: string; changed_by: string | null }[]
  grants?: { id: number; salesman_id: number; salesman: string; since: string; granted_by: string | null }[]
  salesman_options?: { id: number; name: string }[]
}
interface Visit { id: number; visited_at: string; salesman: string; mine: boolean; notes: string; source: string; has_order: boolean; items: { name: string; quantity: number; unit: string }[]; followup_due: string | null }
interface Fu { id: number; due_date: string; salesman: string; priority: string; outcome: string; notes: string; state: string }
interface Ev { at: string; type: string; text: string }
interface Page<T> { count: number; results: T[] }

type Tab = 'overview' | 'visits' | 'orders' | 'followups' | 'activity'
const FIELDS: [keyof Profile, string][] = [
  ['name', 'Dealer name'], ['shop_name', 'Shop name'], ['phone', 'Phone'], ['whatsapp', 'WhatsApp'], ['address', 'Address'],
  ['city', 'City'], ['state', 'State'], ['pincode', 'Pincode'], ['gst_number', 'GST number'],
]
const STATUSES = ['Prospect', 'New', 'Active', 'Inactive', 'Converted', 'Lost']
const errText = (e: unknown) => (e instanceof ApiError ? flatten(e.data).join(' · ') || 'Request failed' : 'Network error. Please try again.')

function Card({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mb-6 rounded-2xl border bg-white p-5 shadow-sm">
      <div className="mb-3 flex items-center justify-between"><h2 className="font-semibold">{title}</h2>{action}</div>
      {children}
    </section>
  )
}

function Rows<T>({ path, head, row }: { path: string; head: string[]; row: (r: T, i: number) => React.ReactNode }) {
  const [page, setPage] = useState(1)
  const { data, loading, error } = useApi<Page<T>>(`${path}?page=${page}`)
  return (
    <>
      <Table head={head.map((label) => ({ label }))} loading={loading} error={error} empty={data?.results.length === 0}>{data?.results.map((r, i) => row(r, i))}</Table>
      <Pager page={page} count={data?.count ?? 0} onChange={setPage} />
    </>
  )
}

function Profile({ d, onSaved }: { d: Detail; onSaved: () => void }) {
  const p = d.profile
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const start = () => { setForm({ ...Object.fromEntries(FIELDS.map(([k]) => [k, String(p[k] ?? '')])), status: p.status }); setErr(''); setEditing(true) }
  const save = async () => {
    setBusy(true); setErr('')
    try { await api(`/api/dealers/${p.id}/`, { method: 'PATCH', body: form }); setEditing(false); onSaved() }
    catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }
  const archive = async () => {
    setBusy(true); setErr('')
    try { await api(`/api/dealers/${p.id}/`, { method: 'PATCH', body: { is_archived: !p.is_archived } }); onSaved() }
    catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }

  const action = d.permissions.can_edit && (
    <div className="flex gap-2">
      {editing ? (
        <>
          <button onClick={() => setEditing(false)} className="rounded-lg border px-3 py-1.5 text-sm">Cancel</button>
          <button onClick={save} disabled={busy} className="rounded-lg bg-primary hover:bg-primary-hover px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">{busy ? 'Saving…' : 'Save'}</button>
        </>
      ) : (
        <>
          <button onClick={archive} disabled={busy} className="rounded-lg border px-3 py-1.5 text-sm">{p.is_archived ? 'Restore' : 'Archive'}</button>
          <button onClick={start} className="rounded-lg border px-3 py-1.5 text-sm font-medium">Edit</button>
        </>
      )}
    </div>
  )

  return (
    <Card title="Profile & business information" action={action}>
      {err && <p role="alert" className="mb-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">{err}</p>}
      {editing ? (
        <div className="grid grid-cols-3 gap-3">
          {FIELDS.map(([k, label]) => (
            <label key={k} className="flex flex-col gap-1 text-xs text-slate-600">{label}
              {k === 'state'
                ? <StateSelect value={form[k] ?? ''} onChange={(v) => setForm({ ...form, state: v })} className="rounded-lg border bg-white px-3 py-2.5 text-sm text-slate-900" />
                : <input value={form[k] ?? ''} onChange={(e) => setForm({ ...form, [k]: e.target.value })} className="rounded-lg border px-3 py-2.5 text-sm text-slate-900" />}
            </label>
          ))}
          <label className="flex flex-col gap-1 text-xs text-slate-600">Status
            <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} className="rounded-lg border bg-white px-3 py-2.5 text-sm text-slate-900">
              <option value="">—</option>{STATUSES.map((s) => <option key={s}>{s}</option>)}
            </select>
          </label>
        </div>
      ) : (
        <dl className="grid grid-cols-3 gap-x-6 gap-y-3 text-sm">
          {[...FIELDS.map(([k, l]) => [l, p[k]] as const), ['Distributor', p.distributor], ['Last visit', fmtDate(p.last_visit_at)], ['Next follow-up', fmtDate(p.next_followup)], ['Added', fmtDate(p.created_at)]].map(([l, v]) => (
            <div key={String(l)}><dt className="text-xs text-slate-500">{l}</dt><dd className="font-medium">{String(v || '—')}</dd></div>
          ))}
        </dl>
      )}
    </Card>
  )
}

function Ownership({ d, onChanged }: { d: Detail; onChanged: () => void }) {
  const [sid, setSid] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const options = (d.salesman_options ?? []).filter((s) => s.id !== d.owner?.id)

  const transfer = async () => {
    if (!sid || busy) return
    setBusy(true); setErr('')
    try { await api(`/api/dealers/${d.profile.id}/transfer/`, { method: 'POST', body: { salesman_id: Number(sid), reason } }); setSid(''); setReason(''); onChanged() }
    catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }

  return (
    <Card title="Ownership">
      <p className="mb-3 text-sm">Current owner: {d.owner ? <><b>{d.owner.name}</b> <span className="text-slate-500">since {fmtDate(d.owner.since)}</span></> : <span className="text-amber-800">Unassigned</span>}</p>
      {d.permissions.can_transfer && (
        <div className="mb-4 flex items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-slate-600">{d.owner ? 'Transfer to' : 'Assign to'}
            <select value={sid} onChange={(e) => setSid(e.target.value)} className="rounded-lg border bg-white px-3 py-2.5 text-sm text-slate-900">
              <option value="">Select salesman</option>{options.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label className="flex flex-1 flex-col gap-1 text-xs text-slate-600">Reason (optional)
            <input value={reason} onChange={(e) => setReason(e.target.value)} className="rounded-lg border px-3 py-2.5 text-sm text-slate-900" />
          </label>
          <button onClick={transfer} disabled={!sid || busy} className="rounded-lg bg-primary hover:bg-primary-hover px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50">{busy ? 'Saving…' : d.owner ? 'Transfer' : 'Assign'}</button>
        </div>
      )}
      {err && <p role="alert" className="mb-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">{err}</p>}
      <h3 className="mb-2 text-xs font-medium uppercase text-slate-500">Ownership history</h3>
      {d.ownership_history?.length ? (
        <ul className="divide-y text-sm">
          {d.ownership_history.map((o) => (
            <li key={o.id} className="flex justify-between py-2">
              <span><b>{o.salesman}</b> {o.ended_at ? '' : <Badge tone="green">Current</Badge>}{o.reason && <span className="text-slate-500"> — {o.reason}</span>}</span>
              <span className="text-slate-500">{fmtDate(o.started_at)} → {o.ended_at ? fmtDate(o.ended_at) : 'now'}{o.changed_by && ` · by ${o.changed_by}`}</span>
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-slate-500">No ownership recorded.</p>}
    </Card>
  )
}

function Access({ d, onChanged }: { d: Detail; onChanged: () => void }) {
  const [sid, setSid] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const admin = d.permissions.can_manage_access
  const granted = new Set((d.grants ?? []).map((g) => g.salesman_id))
  const options = (d.salesman_options ?? []).filter((s) => s.id !== d.owner?.id && !granted.has(s.id))

  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true); setErr('')
    try { await fn(); onChanged() } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }

  return (
    <Card title="Access grants">
      <p className="mb-3 text-sm text-slate-500">Salesmen who can see this dealer in addition to its owner.</p>
      {admin && (
        <div className="mb-4 flex items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-slate-600">Grant access to
            <select value={sid} onChange={(e) => setSid(e.target.value)} className="rounded-lg border bg-white px-3 py-2.5 text-sm text-slate-900">
              <option value="">Select salesman</option>{options.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <button disabled={!sid || busy} onClick={() => run(async () => { await api(`/api/dealers/${d.profile.id}/grants/`, { method: 'POST', body: { salesman_id: Number(sid) } }); setSid('') })}
            className="rounded-lg bg-primary hover:bg-primary-hover px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50">Grant access</button>
        </div>
      )}
      {err && <p role="alert" className="mb-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">{err}</p>}
      {d.grants?.length ? (
        <ul className="divide-y text-sm">
          {d.grants.map((g) => (
            <li key={g.id} className="flex items-center justify-between py-2">
              <span><b>{g.salesman}</b> <span className="text-slate-500">since {fmtDate(g.since)}{g.granted_by && ` · by ${g.granted_by}`}</span></span>
              {admin && <button disabled={busy} onClick={() => run(() => api(`/api/dealers/${d.profile.id}/grants/${g.id}/revoke/`, { method: 'POST' }))} className="text-red-600 hover:underline disabled:opacity-50">Revoke</button>}
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-slate-500">No extra access granted.</p>}
    </Card>
  )
}

export default function DealerDetail() {
  const { id } = useParams()
  const { me } = useOutletContext<{ me: Me }>()
  const salesman = me.role === 'salesman'
  const back = salesman ? '/my-dealers' : '/dealers'
  return <DealerContent key={id} id={id!} salesman={salesman} back={back} />
}

function DealerContent({ id, salesman, back }: { id: string; salesman: boolean; back: string }) {
  const [tab, setTab] = useState<Tab>(salesman ? 'orders' : 'overview')
  const [v, setV] = useState(0)
  const { data: d, loading, error } = useApi<Detail>(`/api/dealers/${id}/?v=${v}`)
  const reload = () => setV((n) => n + 1)
  const base = `/api/dealers/${id}`

  if (loading && !d) return <p className="text-slate-500">Loading…</p>
  if (error || !d) return (
    <>
      <PageHeader title="Dealer not found" subtitle="It may have been removed, or you may not have access." />
      <Link to={back} className="text-primary hover:underline">← Back to dealers</Link>
    </>
  )
  const p = d.profile

  return (
    <>
      <Link to={back} className="mb-2 inline-block text-sm text-primary hover:underline">← Dealers</Link>
      <PageHeader title={p.name} subtitle={[p.shop_name, [p.city, p.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}
        action={<div className="flex gap-2">{p.status && <Badge>{p.status}</Badge>}{p.is_archived && <Badge tone="gray">Archived</Badge>}</div>} />
      <StatStrip items={[
        { label: 'Visits', value: d.stats.visits }, { label: 'Orders', value: d.stats.orders },
        { label: 'Pending Follow-ups', value: d.stats.pending_followups }, { label: 'Overdue Follow-ups', value: d.stats.overdue_followups, tone: d.stats.overdue_followups ? 'red' : undefined },
      ]} />
      <div className="mb-5"><Pills value={tab} onChange={setTab} options={[['overview', 'Overview'], ['visits', 'Visits'], ['orders', 'Orders'], ['followups', 'Follow-ups'], ['activity', 'Activity']]} /></div>
      {salesman && <p role="note" className="mb-5 rounded-lg border bg-slate-50 p-3 text-sm text-slate-600">History is read-only. Each order shows the salesman who originally created it, including orders recorded before an area transfer.</p>}

      {tab === 'overview' && (
        <>
          <Profile d={d} onSaved={reload} />
          <Card title="Contacts">
            {d.contacts.length ? (
              <ul className="divide-y text-sm">
                {d.contacts.map((c) => (
                  <li key={c.id} className="flex justify-between py-2">
                    <span><b>{c.name}</b>{c.designation && <span className="text-slate-500"> · {c.designation}</span>}</span>
                    <span className="text-slate-600">{[c.phone, c.email].filter(Boolean).join(' · ') || '—'}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-slate-500">No contacts saved.</p>}
          </Card>
          {d.ownership_history && <Ownership d={d} onChanged={reload} />}
          {d.grants && <Access d={d} onChanged={reload} />}
        </>
      )}
      {tab === 'visits' && (
        <Rows<Visit> key="visits" path={`${base}/visits/`} head={['Date', 'Salesman', 'Notes', 'Order', 'Follow-up']}
          row={(r) => (
            <tr key={r.id}>
              <td className="px-3 py-3">{fmtDate(r.visited_at, true)} <span className="text-slate-500">{fmtTime(r.visited_at)}</span></td>
              <td className="px-3">{r.salesman}</td><td className="px-3 text-slate-600">{r.notes || '—'}</td>
              <td className="px-3">{r.has_order ? <Badge tone="green">Order</Badge> : '—'}</td><td className="px-3 text-slate-600">{fmtDate(r.followup_due, true)}</td>
            </tr>
          )} />
      )}
      {tab === 'orders' && (
        <Rows<Visit> key="orders" path={`${base}/orders/`} head={['Date', 'Original salesman', 'Items']}
          row={(r) => (
            <tr key={r.id}>
              <td className="px-3 py-3">{fmtDate(r.visited_at, true)}</td><td className="px-3">{r.salesman}</td>
              <td className="px-3 py-3 text-slate-600"><ul className="space-y-1">{r.items.map((i, n) => <li key={n}><span className="font-medium">{i.name} – {r.salesman}</span><span className="ml-2 text-xs">{i.quantity} {i.unit}</span></li>)}</ul></td>
            </tr>
          )} />
      )}
      {tab === 'followups' && (
        <Rows<Fu> key="followups" path={`${base}/followups/`} head={['Due', 'Salesman', 'Priority', 'Outcome', 'State']}
          row={(r) => (
            <tr key={r.id}>
              <td className="px-3 py-3">{fmtDate(r.due_date, true)}</td><td className="px-3">{r.salesman}</td>
              <td className="px-3 capitalize">{r.priority}</td><td className="px-3 text-slate-600">{r.outcome ? r.outcome.replace(/_/g, ' ') : '—'}</td>
              <td className="px-3"><Badge tone={r.state === 'overdue' ? 'red' : r.state === 'completed' ? 'green' : 'blue'}>{r.state.replace(/_/g, ' ')}</Badge></td>
            </tr>
          )} />
      )}
      {tab === 'activity' && (
        <Rows<Ev> key="activity" path={`${base}/activity/`} head={['When', 'Type', 'Event']}
          row={(r, i) => (
            <tr key={`${r.at}-${i}`}>
              <td className="whitespace-nowrap px-3 py-3 text-slate-600">{fmtDate(r.at, true)} {fmtTime(r.at)}</td>
              <td className="px-3"><Badge tone="gray">{r.type}</Badge></td><td className="px-3">{r.text}</td>
            </tr>
          )} />
      )}
    </>
  )
}
