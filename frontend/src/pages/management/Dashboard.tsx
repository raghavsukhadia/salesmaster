import { Link, useOutletContext } from 'react-router-dom'
import { ArrowRight, CalendarClock, CalendarX, ClipboardCheck, RefreshCw, Store, UserPlus, UserX, Users } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { Me } from '../../auth'
import { useDateRange } from '../../components/DateRange'
import { dealerSeverity, pct } from '../../components/logic'
import { Badge, Button, buttonClass, Card, ErrorState, fmtTime, PageHeader, Skeleton, useApi, type Tone } from '../../components/ui'
import RecentVisits, { ViewAll, type VisitRow } from './RecentVisits'
import SalesmanActivity, { type ActivityRow } from './SalesmanActivity'

interface Data {
  kpis: { total_dealers: number; visits_today: number; active_salesmen: number; new_dealers_today: number; pending_followups: number; overdue_followups: number }
  trends: { visits_yesterday: number; new_dealers_yesterday: number }
  unassigned_dealers: number
  overdue_followups: number
  no_recent_visit: number
  salesman_activity: ActivityRow[]
}
interface Visits { count: number; results: VisitRow[] }

const RECENT = 8

function Kpi({ icon: Icon, chip, label, value, sub, to }: { icon: LucideIcon; chip: string; label: string; value: number; sub: string; to: string }) {
  return (
    <Link to={to} className="group block rounded-xl border bg-white p-4 shadow-card transition-colors hover:border-slate-300">
      <div className="flex min-h-10 items-start justify-between gap-2">
        <span className="text-sm font-medium text-slate-600">{label}</span>
        <span className={`grid size-8 shrink-0 place-items-center rounded-lg ${chip}`}><Icon size={16} strokeWidth={1.9} aria-hidden /></span>
      </div>
      <div className="mt-3 text-3xl font-semibold tabular-nums tracking-tight text-slate-900">{value.toLocaleString('en-IN')}</div>
      <div className="mt-1 flex items-center justify-between text-xs text-slate-500">
        <span>{sub}</span>
        <ArrowRight size={14} aria-hidden className="text-slate-300 transition-colors group-hover:text-slate-600" />
      </div>
    </Link>
  )
}

interface Severity { label: 'High' | 'Medium' | 'Low' | 'Clear'; tone: Tone; bar: string }
const SEV: Record<Severity['label'], Severity> = {
  High: { label: 'High', tone: 'red', bar: 'bg-red-500' },
  Medium: { label: 'Medium', tone: 'amber', bar: 'bg-amber-500' },
  Low: { label: 'Low', tone: 'gray', bar: 'bg-slate-300' },
  Clear: { label: 'Clear', tone: 'green', bar: 'bg-green-500' },
}
/** Dealer counts are judged by share of all dealers (see dealerSeverity); any overdue follow-up is a missed commitment, so it is High. */
const dealerSev = (n: number, total: number) => SEV[dealerSeverity(n, total)]

function ActionCard({ icon: Icon, title, count, text, sev, cta, to }: { icon: LucideIcon; title: string; count: number; text: string; sev: Severity; cta: string; to: string }) {
  return (
    <Card className="flex flex-col overflow-hidden">
      <div aria-hidden className={`h-1 ${sev.bar}`} />
      <div className="flex flex-1 flex-col p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-700"><Icon size={18} strokeWidth={1.9} aria-hidden /></span>
          <h3 className="font-semibold text-slate-900">{title}</h3>
        </div>
        <Badge tone={sev.tone}><span className="sr-only">Severity: </span>{sev.label}</Badge>
      </div>
      <div className="mt-4 text-3xl font-semibold tabular-nums tracking-tight text-slate-900">{count.toLocaleString('en-IN')}</div>
      <p className="mt-1 text-sm text-slate-500">{text}</p>
      <div className="mt-auto pt-4"><Link to={to} className={buttonClass('secondary', 'sm')}>{cta}<ArrowRight size={14} aria-hidden /></Link></div>
      </div>
    </Card>
  )
}

export default function Dashboard() {
  const { me } = useOutletContext<{ me: Me }>()
  const [range, , rangeLabel] = useDateRange()
  const dash = useApi<Data>('/api/management/dashboard/')
  const visits = useApi<Visits>(`/api/management/visits/?range=${range}&page=1`)
  const d = dash.data
  const updatedAt = dash.updatedAt
  const refresh = () => { dash.reload(); visits.reload() }
  const busy = dash.loading || visits.loading

  const activeToday = d?.salesman_activity.filter((s) => s.visits_today > 0).length ?? 0
  const rows = visits.data?.results.slice(0, RECENT) ?? []
  const allVisits = `/visits${range === 'month' ? '' : `?range=${range}`}`

  return (
    <>
      <PageHeader title="Dashboard"
        action={<>
          {updatedAt && <span className="text-xs text-slate-500">Updated {fmtTime(updatedAt)}</span>}
          <Button variant="secondary" onClick={refresh} loading={busy}><RefreshCw size={16} aria-hidden />Refresh</Button>
        </>} />

      {dash.error && !d && <Card className="mb-8"><ErrorState message="Could not load the dashboard." onRetry={dash.reload} /></Card>}

      <section aria-label="Key metrics" className="mb-8 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        {!d && !dash.error && Array.from({ length: 6 }, (_, i) => (
          <Card key={i} className="p-4" aria-hidden><Skeleton className="h-4 w-24" /><Skeleton className="mt-4 h-8 w-16" /><Skeleton className="mt-3 h-3 w-20" /></Card>
        ))}
        {d && <>
          <Kpi icon={Store} chip="bg-primary-soft text-primary" label="Total dealers" value={d.kpis.total_dealers} sub={`${d.unassigned_dealers} unassigned`} to="/dealers" />
          <Kpi icon={ClipboardCheck} chip="bg-primary-soft text-primary" label="Visits today" value={d.kpis.visits_today} sub={`Yesterday: ${d.trends.visits_yesterday}`} to="/visits?range=today" />
          <Kpi icon={Users} chip="bg-green-50 text-green-700" label="Active salesman" value={d.kpis.active_salesmen} sub={`${activeToday} visited today`} to="/salesmen" />
          <Kpi icon={UserPlus} chip="bg-accent-soft text-accent-ink" label="New dealers today" value={d.kpis.new_dealers_today} sub={`Yesterday: ${d.trends.new_dealers_yesterday}`} to="/dealers?sort=newest" />
          <Kpi icon={CalendarClock} chip="bg-amber-50 text-amber-700" label="Pending follow-ups" value={d.kpis.pending_followups} sub={`${d.kpis.overdue_followups} overdue`} to="/followups-management" />
          <Kpi icon={CalendarX} chip="bg-red-50 text-red-600" label="Overdue follow-ups" value={d.kpis.overdue_followups} sub={d.kpis.overdue_followups ? 'Needs attention' : 'All on track'} to="/followups-management?tab=overdue" />
        </>}
      </section>

      {d && (
        <section aria-labelledby="action-h" className="mb-8">
          <div className="mb-3">
            <h2 id="action-h" className="text-lg font-semibold text-slate-900">Action required</h2>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <ActionCard icon={UserX} title="Unassigned dealers" count={d.unassigned_dealers} sev={dealerSev(d.unassigned_dealers, d.kpis.total_dealers)}
              text={`No current owning salesman. ${pct(d.unassigned_dealers, d.kpis.total_dealers)}% of ${d.kpis.total_dealers} dealers.`} cta="View unassigned dealers" to="/dealers?assignment=unassigned" />
            <ActionCard icon={CalendarX} title="Overdue follow-ups" count={d.overdue_followups} sev={SEV[d.overdue_followups ? 'High' : 'Clear']}
              text={`Past their due date and still pending. ${d.overdue_followups} of ${d.kpis.pending_followups} pending.`} cta="View overdue follow-ups" to="/followups-management?tab=overdue" />
            <ActionCard icon={Store} title="Dealers with no recent visit" count={d.no_recent_visit} sev={dealerSev(d.no_recent_visit, d.kpis.total_dealers)}
              text={`Not visited in the last 30 days, or never. ${pct(d.no_recent_visit, d.kpis.total_dealers)}% of dealers.`} cta="View these dealers" to="/dealers?visit=stale" />
          </div>
        </section>
      )}

      <div className="mb-8">
        <SalesmanActivity rows={d?.salesman_activity ?? []} loading={dash.loading && !d} error={dash.error && !d} onRetry={dash.reload} canAdd={me.role === 'admin'} />
      </div>

      <section aria-labelledby="recent-h" className="-mx-4 rounded-none bg-primary-soft/60 px-4 py-5 sm:mx-0 sm:rounded-2xl sm:p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="grid size-9 place-items-center rounded-xl bg-primary text-white"><ClipboardCheck size={18} aria-hidden /></span>
            <h2 id="recent-h" className="text-lg font-semibold text-slate-900">Recent visits</h2>
            {!visits.loading && rows.length > 0 && <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-semibold text-white">{rows.length}</span>}
          </div>
          <ViewAll to={allVisits}>View all visits</ViewAll>
        </div>
        {/* Skeleton on every refetch: rows from the previous period must never sit under the new period's label. */}
        <RecentVisits rows={rows} loading={visits.loading} error={visits.error && !visits.loading} onRetry={visits.reload} rangeLabel={rangeLabel} />
      </section>
    </>
  )
}
