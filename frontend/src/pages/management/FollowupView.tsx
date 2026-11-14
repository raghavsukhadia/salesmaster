import { Link, useParams } from 'react-router-dom'
import { Badge, fmtDate, fmtTime, useApi } from '../../components/ui'
import { Field, OUTCOME, STATE } from './VisitView'

interface Detail {
  id: number; due_date: string; created_at: string; status: string; state: string; priority: string; outcome: string; notes: string; days_overdue: number
  dealer: { id: number; name: string; shop_name: string; phone: string; whatsapp: string; city: string; state: string; status: string; owner: string | null }
  salesman: { id: number; name: string; phone: string; email: string; active: boolean }
  visit: { id: number; visited_at: string } | null
  parent_id: number | null; next_ids: number[]
  history: { at: string; type: string; text: string }[]
}

const card = 'mb-5 rounded-2xl border bg-white p-5'

export default function FollowupView() {
  const { id } = useParams()
  const { data: f, loading, error } = useApi<Detail>(`/api/management/followups/${id}/`)
  if (loading) return <p className="text-slate-500">Loading…</p>
  if (error || !f) return <div><Link to="/followups-management" className="text-primary hover:underline">← Back to follow-ups</Link><p role="alert" className="mt-3 text-red-700">Follow-up not found or could not be loaded.</p></div>
  const [tone, label] = STATE[f.state] ?? STATE.upcoming
  const d = f.dealer, s = f.salesman
  return (
    <>
      <Link to="/followups-management" className="mb-2 inline-block text-sm text-primary hover:underline">← Follow-ups</Link>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">Follow-up: {d.name}</h1>
        <Badge tone={tone}>{label}</Badge>
        <span className="text-sm capitalize text-slate-500">{f.priority} priority</span>
      </div>

      <section className={card}>
        <h2 className="mb-3 font-semibold">Follow-up</h2>
        <dl className="grid gap-3 md:grid-cols-4">
          <Field label="Due date"><span className={f.state === 'overdue' ? 'font-medium text-red-700' : ''}>{fmtDate(f.due_date)}</span>{f.days_overdue > 0 && <span className="ml-2 text-xs text-red-700">{f.days_overdue} day(s) overdue</span>}</Field>
          <Field label="Status"><span className="capitalize">{f.status}</span></Field>
          <Field label="Priority"><span className="capitalize">{f.priority}</span></Field>
          <Field label="Call outcome">{OUTCOME[f.outcome]}</Field>
          <Field label="Created">{`${fmtDate(f.created_at)} ${fmtTime(f.created_at)}`}</Field>
          <Field label="From visit">{f.visit ? <Link to={`/visits/${f.visit.id}`} className="text-primary hover:underline">{fmtDate(f.visit.visited_at)} · {fmtTime(f.visit.visited_at)}</Link> : ''}</Field>
          <Field label="Earlier follow-up">{f.parent_id ? <Link to={`/followups-management/${f.parent_id}`} className="text-primary hover:underline">#{f.parent_id}</Link> : ''}</Field>
          <Field label="Next follow-up">{f.next_ids.length ? f.next_ids.map((n) => <Link key={n} to={`/followups-management/${n}`} className="mr-2 text-primary hover:underline">#{n}</Link>) : ''}</Field>
        </dl>
        <h3 className="mb-1 mt-4 text-xs text-slate-500">Notes</h3>
        <p className="whitespace-pre-wrap text-sm">{f.notes || <span className="text-slate-500">No notes</span>}</p>
      </section>

      <div className="grid gap-5 md:grid-cols-2">
        <section className={card}>
          <h2 className="mb-3 font-semibold">Dealer</h2>
          <dl className="grid grid-cols-2 gap-3">
            <Field label="Name"><Link to={`/dealers/${d.id}`} className="text-primary hover:underline">{d.name}</Link></Field>
            <Field label="Shop">{d.shop_name}</Field><Field label="Phone">{d.phone}</Field><Field label="WhatsApp">{d.whatsapp}</Field>
            <Field label="Location">{[d.city, d.state].filter(Boolean).join(', ')}</Field><Field label="Status">{d.status}</Field>
            <Field label="Current owner">{d.owner ?? 'Unassigned'}</Field>
          </dl>
        </section>
        <section className={card}>
          <h2 className="mb-3 font-semibold">Salesman</h2>
          <dl className="grid grid-cols-2 gap-3">
            <Field label="Name"><Link to={`/salesmen/${s.id}`} className="text-primary hover:underline">{s.name}</Link>{!s.active && <span className="ml-2 text-xs text-slate-500">Inactive</span>}</Field>
            <Field label="Phone">{s.phone}</Field><Field label="Email">{s.email}</Field>
          </dl>
        </section>
      </div>

      <section className={card}>
        <h2 className="mb-1 font-semibold">Activity history</h2>
        <p className="mb-3 text-xs text-slate-500">Built from the visit and linked follow-ups. Individual status changes are not logged with a time.</p>
        <ol className="space-y-2">
          {f.history.map((e, i) => (
            <li key={i} className="flex gap-3 text-sm"><span className="w-40 shrink-0 text-slate-500">{fmtDate(e.at)} · {fmtTime(e.at)}</span><span>{e.text}</span></li>
          ))}
        </ol>
      </section>
    </>
  )
}
