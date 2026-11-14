import { useState } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import { ArrowDown, ArrowUp, CircleAlert, Info, TriangleAlert, UserRound } from 'lucide-react'
import { Card, DropdownSelect, ErrorState, Pills, Skeleton } from '../../components/ui'
import { ChartCard } from './charts'
import { fillPath, fmtCard, fmtDay, fmtInt, fmtMonth, fmtPct } from './format'
import ReportTable from './ReportTable'
import { useReportParams } from './useReportParams'
import { MEASURES, chartHasData, type Card as KpiCard, type Measure, type Ranking, type Report, type ReportCtx, type Row } from './types'

function Kpi({ c }: { c: KpiCard }) {
  const text = c.format === 'text'
  const up = typeof c.value === 'number' && c.value > 0
  const down = typeof c.value === 'number' && c.value < 0
  return (
    <Card className="p-4 print:break-inside-avoid">
      <div className="text-sm font-medium text-slate-600">{c.label}</div>
      <div title={text ? String(c.value ?? '') : undefined}
        className={`mt-2 truncate font-semibold tracking-tight ${text ? 'text-xl leading-9' : 'text-3xl tabular-nums'} ${c.format === 'change' ? (up ? 'text-[#006300]' : down ? 'text-red-700' : 'text-slate-900') : 'text-slate-900'}`}>
        {c.format === 'change' && up && <ArrowUp size={20} className="mr-1 inline" aria-hidden />}
        {c.format === 'change' && down && <ArrowDown size={20} className="mr-1 inline" aria-hidden />}
        {fmtCard(c)}
      </div>
      {c.hint && <div className="mt-1 text-xs text-slate-500">{c.hint}</div>}
    </Card>
  )
}

function Leaderboard({ r }: { r: Ranking }) {
  const max = Math.max(1, ...r.rows.map((x) => x.value))
  const show = (v: number) => (r.format === 'pct' ? fmtPct(v) : fmtInt(v))
  return (
    <Card className="p-4 print:break-inside-avoid">
      <h3 className="font-semibold text-slate-900">{r.title}</h3>
      <p className="mb-3 text-xs text-slate-500">Top {r.rows.length || 10} · {r.unit}</p>
      {r.rows.length === 0 ? <p className="py-6 text-center text-sm text-slate-500">Nothing to rank yet.</p> : (
        <ol className="space-y-2.5">
          {r.rows.map((x) => (
            <li key={String(x.id)} className="grid grid-cols-[1.75rem_1fr_auto] items-center gap-x-2">
              <span className={`grid size-6 place-items-center rounded-full text-xs font-semibold ${x.rank === 1 ? 'bg-accent text-primary' : 'bg-primary-soft text-primary'}`}>{x.rank}</span>
              <div className="min-w-0">
                <div className="flex items-baseline justify-between gap-2">
                  <Link to={`${fillPath(r.link.path, { id: x.id })}${r.link.search ? `?${r.link.search}` : ''}`} className="truncate text-sm font-medium text-slate-900 hover:text-primary hover:underline">{x.name}</Link>
                </div>
                <div className="mt-1 h-1.5 rounded-full bg-primary-soft"><div className="h-full rounded-full bg-[#2a78d6]" style={{ width: `${Math.max(2, (x.value / max) * 100)}%` }} /></div>
                {x.note && <div className="mt-0.5 text-xs text-slate-500">{x.note}</div>}
              </div>
              <span className="text-sm font-semibold tabular-nums text-slate-900">{show(x.value)}</span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  )
}

function Options({ data }: { data: Report }) {
  const { setParam } = useReportParams()
  const ctx = useOutletContext<ReportCtx | undefined>()
  const [current] = useState(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` })
  if (!data.options.length) return null
  return (
    <div className="mb-6 flex flex-wrap items-end gap-4 print:hidden">
      {data.options.map((o) => {
        if (o.type === 'choice') {
          return (
            <div key={o.key}>
              <div className="mb-1 text-xs font-medium text-slate-600">{o.label}</div>
              <Pills value={String(o.value)} options={(o.choices ?? []) as [string, string][]} onChange={(v) => setParam(o.key, v)} />
            </div>
          )
        }
        const months = [...new Set([current, String(o.value), ...(ctx?.options?.months ?? [])])].sort().reverse()
        return (
          <div key={o.key} className="w-48">
            <DropdownSelect label={o.label} value={String(o.value)} onChange={(v) => setParam(o.key, v)} options={months.map((m) => ({ value: m, label: fmtMonth(m) }))} />
          </div>
        )
      })}
    </div>
  )
}

interface Props {
  data: Report | null
  loading: boolean
  error: boolean
  onRetry: () => void
  /** Adds a per-row button to one table, e.g. editing a salesman's targets. */
  rowAction?: { table: string; label: string; onClick: (row: Row) => void }
}

/** Renders any report payload: key figures, charts, leaderboards and tables, plus the filters it was built with. */
export default function ReportView({ data, loading, error, onRetry, rowAction }: Props) {
  const [measure, setMeasure] = useState<Measure>('qty')
  const [printedAt] = useState(() => new Date().toLocaleString('en-GB'))
  const { setFilters } = useReportParams()

  if (!data) {
    if (error) return <Card><ErrorState message="Could not load this report." onRetry={onRetry} /></Card>
    return (
      <div role="status" aria-label="Loading report" className="space-y-6">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
          {Array.from({ length: 6 }, (_, i) => <Card key={i} className="p-4" aria-hidden><Skeleton className="h-4 w-24" /><Skeleton className="mt-4 h-8 w-16" /><Skeleton className="mt-3 h-3 w-20" /></Card>)}
        </div>
        <div className="grid gap-4 lg:grid-cols-2">{[0, 1].map((i) => <Card key={i} className="h-72 p-4" aria-hidden><Skeleton className="h-4 w-40" /><Skeleton className="mt-6 h-48 w-full" /></Card>)}</div>
      </div>
    )
  }

  const { meta } = data
  const range = meta.range.from ? `${fmtDay(meta.range.from)} – ${fmtDay(meta.range.to)}` : 'Every date'
  const chips = meta.filters.filter((f) => f.label !== 'Period')
  const measurable = data.charts.some((c) => c.measurable)
  // The Quantity/Orders switch is only worth showing when a chart it controls has something to draw under either choice.
  const anyChartData = data.charts.some((c) => c.measurable && MEASURES.some(([m]) => chartHasData(c, m)))

  return (
    <div aria-busy={loading || undefined}>
      {/* Only shown on paper, where the filter bar and sidebar are hidden. */}
      <div className="mb-4 hidden print:block">
        <h1 className="text-xl font-semibold">{data.title}</h1>
        <p className="text-sm text-slate-600">{meta.filters.map((f) => `${f.label}: ${f.value}`).join(' · ')} · printed {printedAt}</p>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-slate-600 print:hidden">
        <span><span className="font-medium text-slate-900">{meta.range.label}</span> · {range}</span>
        {chips.map((c) => <span key={c.label} className="rounded-full border bg-slate-50 px-2.5 py-0.5 text-xs">{c.label}: <span className="font-medium text-slate-900">{c.value}</span></span>)}
        {meta.unit && meta.unit !== 'mixed' && <span className="rounded-full border bg-slate-50 px-2.5 py-0.5 text-xs">Quantity in <span className="font-medium text-slate-900">{meta.unit}</span></span>}
        {meta.scope === 'own' && <span className="inline-flex items-center gap-1 rounded-full border border-primary-line bg-primary-soft px-2.5 py-0.5 text-xs text-primary"><UserRound size={12} aria-hidden />Your own records only</span>}
        {error && <span role="alert" className="inline-flex items-center gap-1 text-xs text-red-700"><CircleAlert size={13} aria-hidden />Could not refresh. <button type="button" onClick={onRetry} className="font-medium underline">Try again</button></span>}
      </div>

      <div className={`transition-opacity ${loading ? 'opacity-60' : ''}`}>
        <Options data={data} />

        {data.warnings.length > 0 && (
          <div role="note" className="mb-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 print:break-inside-avoid">
            {data.warnings.map((w) => <p key={w} className="flex gap-2"><TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />{w}</p>)}
            <div className="mt-3 flex flex-wrap items-center gap-2 pl-6 print:hidden">
              <span className="text-xs font-medium">Show only:</span>
              {meta.units.map((u) => (
                <button key={u} type="button" onClick={() => setFilters({ unit: u })}
                  className="h-8 rounded-full border border-amber-300 bg-white px-3 text-sm font-medium text-amber-900 hover:bg-amber-100">{u}</button>
              ))}
            </div>
          </div>
        )}

        {data.cards.length > 0 && (
          <section aria-label="Key figures" className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-[repeat(var(--n),minmax(0,1fr))]" style={{ '--n': Math.min(6, data.cards.length) } as React.CSSProperties}>
            {data.cards.map((c) => <Kpi key={c.key} c={c} />)}
          </section>
        )}

        {measurable && anyChartData && (
          <div className="mb-3 flex flex-wrap items-center gap-3 print:hidden">
            <span className="text-sm text-slate-600">Show charts by</span>
            <Pills value={measure} options={MEASURES.map(([k, l]) => [k, l] as [Measure, string])} onChange={setMeasure} />
          </div>
        )}
        {data.charts.some((c) => chartHasData(c, measure)) && (
          <section aria-label="Charts" className="mb-6 grid gap-4 lg:grid-cols-2">
            {data.charts.map((c) => <ChartCard key={c.id} chart={c} measure={measure} unit={meta.unit} busy={loading} />)}
          </section>
        )}

        {data.rankings.length > 0 && (
          <section aria-label="Leaderboards" className="mb-6">
            <h2 className="mb-3 text-lg font-semibold text-slate-900">Leaderboards</h2>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{data.rankings.map((r) => <Leaderboard key={r.id} r={r} />)}</div>
          </section>
        )}

        {data.tables.length > 0 && (
          <section aria-label="Tables" className="space-y-6">
            {data.tables.map((t) => <ReportTable key={t.id} table={t} rowAction={rowAction && rowAction.table === t.id ? rowAction : undefined} />)}
          </section>
        )}

        {data.notes.length > 0 && (
          <ul className="mt-6 space-y-1.5 text-xs text-slate-500">
            {data.notes.map((n) => <li key={n} className="flex gap-1.5"><Info size={13} className="mt-0.5 shrink-0" aria-hidden />{n}</li>)}
          </ul>
        )}
      </div>
    </div>
  )
}
