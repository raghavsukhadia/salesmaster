import { useEffect, useRef, useState } from 'react'
import { ChartColumn, Table2 } from 'lucide-react'
import { Card } from '../../components/ui'
import { columnPath, compact, labelIndices, niceAxis, nearestIndex } from './chartMath'
import { fmtDec, fmtInt, fmtPct, fmtX } from './format'
import { MEASURES, chartHasData, type Chart, type Measure, type Row, type Series, type XKind } from './types'

// Light-theme tokens from the validated data-viz palette (series 1 blue, series 2 orange; both pass the colour-blind checks).
const BLUE = '#2a78d6'
const ORANGE = '#eb6834'
const AQUA = '#1baf7a'
const GRAY = '#c3c2b7'
const GRID = '#e1e0d9'
const MUTED = '#898781'
const SURFACE = '#ffffff'
const SERIES = [BLUE, ORANGE]

const num = (p: Row, k: string) => (typeof p[k] === 'number' ? (p[k] as number) : 0)

function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

/** The key mirrors the mark: a short line for line series, a small square for bars. */
function Legend({ series, shape = 'line' }: { series: Series[]; shape?: 'line' | 'box' }) {
  if (series.length < 2) return null // one series: the chart title already says what is plotted
  return (
    <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
      {series.map((s, i) => (
        <li key={s.key} className="flex items-center gap-1.5"><span aria-hidden className={shape === 'box' ? 'size-2.5 rounded-sm' : 'h-0.5 w-4 rounded'} style={{ background: SERIES[i] }} />{s.label}</li>
      ))}
    </ul>
  )
}

/* ───────────── line and column charts over time ───────────── */

function TimeChart({ points, series, x, kind, name }: { points: Row[]; series: Series[]; x: XKind; kind: 'line' | 'column'; name: string }) {
  const [box, width] = useWidth()
  const [active, setActive] = useState<number | null>(null)
  const H = 260
  const m = { l: 46, r: 14, t: 14, b: 30 }
  const n = points.length
  const iw = Math.max(40, width - m.l - m.r)
  const ih = H - m.t - m.b
  const max = Math.max(0, ...points.flatMap((p) => series.map((s) => num(p, s.key))))
  const axis = niceAxis(max)
  const band = iw / Math.max(1, n)
  const px = (i: number) => (kind === 'column' || n <= 1 ? m.l + band * (i + 0.5) : m.l + (iw * i) / (n - 1))
  const py = (v: number) => m.t + ih - (v / axis.top) * ih
  const first = series[0]?.key ?? ''
  const peak = points.reduce((best, p, i) => (num(p, first) > num(points[best], first) ? i : best), 0)

  const at = (clientX: number, el: Element) => {
    const left = el.getBoundingClientRect().left
    const rel = clientX - left
    return kind === 'column' ? Math.min(n - 1, Math.max(0, Math.floor(rel / band))) : nearestIndex(rel, 0, iw, n)
  }
  const onKey = (e: React.KeyboardEvent) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key]
    if (step) { e.preventDefault(); setActive((a) => Math.min(n - 1, Math.max(0, (a ?? n) + step))) }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0) }
    else if (e.key === 'End') { e.preventDefault(); setActive(n - 1) }
    else if (e.key === 'Escape') setActive(null)
  }

  const slot = Math.min(24, (band * 0.8) / series.length)
  const tip = active !== null ? points[active] : null
  const tipLeft = active !== null ? Math.min(Math.max(0, px(active) + 14), Math.max(0, width - 190)) : 0

  return (
    <div>
      <Legend series={series} shape={kind === 'column' ? 'box' : 'line'} />
      <div ref={box} className="relative" tabIndex={0} onKeyDown={onKey} onFocus={() => setActive((a) => a ?? n - 1)} onBlur={() => setActive(null)}
        onPointerLeave={() => setActive(null)} aria-label={`${name}. Use the left and right arrow keys to read each value.`}
        style={{ outlineOffset: 2 }} role="group">
        {width > 0 && (
          <svg width={width} height={H} role="img" aria-label={`${name}: ${n} points, highest ${fmtInt(num(points[peak], first))} on ${fmtX(String(points[peak]?.label ?? ''), x, false)}`} className="block" style={{ touchAction: 'pan-y' }}>
            {axis.ticks.map((t) => (
              <g key={t}>
                <line x1={m.l} x2={m.l + iw} y1={py(t)} y2={py(t)} stroke={t === 0 ? GRAY : GRID} strokeWidth={1} />
                <text x={m.l - 8} y={py(t) + 4} textAnchor="end" fontSize={11} fill={MUTED}>{compact(t)}</text>
              </g>
            ))}
            {labelIndices(n, iw, kind === 'column' ? 52 : 68).map((i) => (
              <text key={i} x={px(i)} y={H - 9} textAnchor={px(i) + 22 > width ? 'end' : 'middle'} fontSize={11} fill={MUTED}>{fmtX(String(points[i].label), x)}</text>
            ))}

            {kind === 'column' && active !== null && <rect x={m.l + band * active} y={m.t} width={band} height={ih} fill="#f1f5f9" />}
            {kind === 'column' && series.map((s, si) => points.map((p, i) => {
              const v = num(p, s.key)
              const bx = px(i) - (slot * series.length) / 2 + si * slot + (si ? 1 : 0)
              return <path key={`${s.key}${i}`} d={columnPath(bx, py(v), Math.max(2, slot - (series.length > 1 ? 2 : 0)), (v / axis.top) * ih)} fill={SERIES[si]} />
            }))}
            {kind === 'column' && max > 0 && series.length === 1 && (
              <text x={px(peak)} y={py(num(points[peak], first)) - 6} textAnchor="middle" fontSize={11} fontWeight={600} fill="#334155">{fmtInt(num(points[peak], first))}</text>
            )}

            {kind === 'line' && series.map((s, si) => {
              const d = points.map((p, i) => `${i ? 'L' : 'M'}${px(i).toFixed(1)},${py(num(p, s.key)).toFixed(1)}`).join(' ')
              const last = points.length - 1
              return (
                <g key={s.key}>
                  {series.length === 1 && n > 1 && <path d={`${d} L${px(last)},${py(0)} L${px(0)},${py(0)} Z`} fill={SERIES[si]} fillOpacity={0.1} />}
                  <path d={d} fill="none" stroke={SERIES[si]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                  {n > 0 && <circle cx={px(last)} cy={py(num(points[last], s.key))} r={4} fill={SERIES[si]} stroke={SURFACE} strokeWidth={2} />}
                </g>
              )
            })}
            {kind === 'line' && series.length === 1 && n > 0 && active === null && (
              <text x={px(n - 1) - 8} y={py(num(points[n - 1], first)) - 10} textAnchor="end" fontSize={11} fontWeight={600} fill="#334155">{fmtInt(num(points[n - 1], first))}</text>
            )}
            {kind === 'line' && active !== null && (
              <g>
                <line x1={px(active)} x2={px(active)} y1={m.t} y2={m.t + ih} stroke={GRAY} strokeWidth={1} />
                {series.map((s, si) => <circle key={s.key} cx={px(active)} cy={py(num(points[active], s.key))} r={4.5} fill={SERIES[si]} stroke={SURFACE} strokeWidth={2} />)}
              </g>
            )}
            <rect x={m.l} y={m.t} width={iw} height={ih} fill="transparent"
              onPointerMove={(e) => setActive(at(e.clientX, e.currentTarget))} onPointerDown={(e) => setActive(at(e.clientX, e.currentTarget))} />
          </svg>
        )}
        {tip && (
          <div role="status" className="pointer-events-none absolute z-10 w-44 rounded-lg border bg-white p-2.5 text-xs shadow-pop" style={{ left: tipLeft, top: m.t }}>
            <div className="mb-1 font-medium text-slate-500">{fmtX(String(tip.label), x, false)}</div>
            {series.map((s, si) => (
              <div key={s.key} className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-slate-600"><span aria-hidden className="h-0.5 w-3 rounded" style={{ background: SERIES[si] }} />{s.label}</span>
                <span className="font-semibold tabular-nums text-slate-900">{fmtInt(num(tip, s.key))}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/* ───────────── ranked horizontal bars ───────────── */

function HBars({ points, valueKey, unit, limit = 10 }: { points: Row[]; valueKey: string; unit: string; limit?: number }) {
  const rows = points.map((p) => ({ label: String(p.label), v: num(p, valueKey) })).filter((r) => r.v > 0).sort((a, b) => b.v - a.v || a.label.localeCompare(b.label)).slice(0, limit)
  const max = rows[0]?.v ?? 1
  return (
    <ul className="space-y-1.5">
      {rows.map((r) => {
        const w = Math.max(1.5, (r.v / max) * 86)
        return (
          <li key={r.label} title={`${r.label}: ${fmtInt(r.v)} ${unit}`} className="grid grid-cols-[minmax(5.5rem,36%)_1fr] items-center gap-3 rounded px-1 text-sm hover:bg-slate-50">
            <span className="truncate text-slate-700">{r.label}</span>
            <span className="relative block h-6">
              <span className="absolute inset-y-0.5 left-0 rounded-r-[4px]" style={{ width: `${w}%`, background: BLUE }} />
              <span className="absolute top-0.5 text-xs font-semibold leading-5 tabular-nums text-slate-900" style={{ left: `calc(${w}% + 6px)` }}>{fmtInt(r.v)}</span>
            </span>
          </li>
        )
      })}
    </ul>
  )
}

/* ───────────── one whole split into parts ───────────── */

function Segments({ points }: { points: Row[] }) {
  const parts = points.map((p) => ({ label: String(p.label), v: num(p, 'value') }))
  const total = parts.reduce((s, p) => s + p.v, 0)
  const colors = parts.length === 2 ? [BLUE, GRAY] : [BLUE, AQUA, ORANGE, GRAY]
  if (!total) return null
  return (
    <div>
      <div role="img" aria-label={parts.map((p) => `${p.label}: ${p.v} (${fmtPct(Math.round((p.v / total) * 1000) / 10)})`).join(', ')} className="flex h-7 gap-0.5">
        {parts.map((p, i) => {
          const share = (p.v / total) * 100
          if (!p.v) return null
          return (
            <div key={p.label} title={`${p.label}: ${fmtInt(p.v)} (${fmtPct(Math.round(share * 10) / 10)})`}
              className="flex min-w-0 items-center rounded px-2 text-xs font-semibold" style={{ width: `${share}%`, background: colors[i], color: colors[i] === GRAY ? '#1e293b' : '#fff' }}>
              {share >= 14 && <span className="truncate">{fmtInt(p.v)} · {Math.round(share)}%</span>}
            </div>
          )
        })}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
        {parts.map((p, i) => <li key={p.label} className="flex items-center gap-1.5"><span aria-hidden className="size-2.5 rounded-sm" style={{ background: colors[i] }} />{p.label}</li>)}
      </ul>
    </div>
  )
}

/* ───────────── small multiples: two bars per measure, each measure on its own scale ───────────── */

function Compare({ points, series }: { points: Row[]; series: Series[] }) {
  const fmt = (kind: unknown, v: number) => (kind === 'pct' ? fmtPct(v) : kind === 'dec' ? fmtDec(v) : fmtInt(v))
  return (
    <div>
      <Legend series={series} shape="box" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {points.map((p) => {
          const vals = series.slice(0, 2).map((s) => num(p, s.key))
          const max = Math.max(...vals, 1)
          return (
            <div key={String(p.label)} className="rounded-lg border p-3">
              <div className="truncate text-xs font-medium text-slate-600" title={String(p.label)}>{String(p.label)}</div>
              <div className="mt-2 flex h-28 items-end justify-center gap-0.5">
                {vals.map((v, i) => (
                  <div key={i} className="flex h-full w-12 flex-col items-center justify-end" title={`${series[i].label}: ${fmt(p.kind, v)}`}>
                    <span className="mb-0.5 text-xs font-semibold tabular-nums text-slate-800">{fmt(p.kind, v)}</span>
                    <div className="w-6 rounded-t-[4px]" style={{ height: `calc((100% - 20px) * ${v / max})`, minHeight: v > 0 ? 2 : 0, background: SERIES[i] }} />
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ───────────── the card around every chart ───────────── */

function DataTable({ chart, series }: { chart: Chart; series: Series[] }) {
  return (
    <div className="max-h-72 overflow-auto rounded-lg border">
      <table className="w-full text-left text-sm">
        <thead className="sticky top-0 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
          <tr><th scope="col" className="px-3 py-2 font-medium">{chart.type === 'segments' ? 'Part' : 'Name'}</th>
            {(chart.type === 'segments' ? [{ key: 'value', label: 'Count' }] : series).map((s) => <th key={s.key} scope="col" className="px-3 py-2 text-right font-medium">{s.label}</th>)}</tr>
        </thead>
        <tbody className="divide-y">
          {chart.points.map((p, i) => (
            <tr key={i}>
              <td className="px-3 py-1.5">{chart.type === 'compare' ? String(p.label) : fmtX(String(p.label), chart.x, false)}</td>
              {(chart.type === 'segments' ? [{ key: 'value', label: '' }] : series).map((s) => <td key={s.key} className="px-3 py-1.5 text-right tabular-nums">{fmt2(p[s.key], p.kind)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
const fmt2 = (v: unknown, kind: unknown) => (typeof v !== 'number' ? '' : kind === 'pct' ? fmtPct(v) : kind === 'dec' ? fmtDec(v) : fmtInt(v))

export function ChartCard({ chart, measure, unit, busy }: { chart: Chart; measure: Measure; unit?: string; busy?: boolean }) {
  const [view, setView] = useState<'chart' | 'table'>('chart')
  const base = MEASURES.find(([k]) => k === measure)![1]
  // Quantity is only meaningful within one unit, so say which (or that the units are mixed).
  const label = measure === 'qty' && unit ? `${base} (${unit === 'mixed' ? 'mixed units' : unit})` : base
  const series: Series[] = chart.measurable ? [{ key: measure, label }] : chart.series
  const wide = chart.type === 'compare' || chart.type === 'segments'

  if (!chartHasData(chart, measure)) return null

  return (
    <Card className={`p-4 transition-opacity print:break-inside-avoid ${busy ? 'opacity-60' : ''} ${wide ? 'lg:col-span-2' : ''}`}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-semibold text-slate-900">{chart.title}</h3>
          <p className="text-xs text-slate-500">{[chart.subtitle, chart.measurable ? label : ''].filter(Boolean).join(' · ')}</p>
        </div>
        <div role="group" aria-label={`${chart.title} view`} className="flex shrink-0 rounded-lg border p-0.5 print:hidden">
          {([['chart', ChartColumn, 'Chart'], ['table', Table2, 'Table']] as const).map(([v, Icon, l]) => (
            <button key={v} type="button" aria-pressed={view === v} aria-label={`${l} view`} onClick={() => setView(v)}
              className={`grid size-7 place-items-center rounded-md ${view === v ? 'bg-primary text-white' : 'text-slate-500 hover:bg-slate-100'}`}><Icon size={15} aria-hidden /></button>
          ))}
        </div>
      </div>
      {view === 'table' ? <DataTable chart={chart} series={series} />
        : chart.type === 'line' || chart.type === 'column' ? <TimeChart points={chart.points} series={series} x={chart.x} kind={chart.type} name={chart.title} />
        : chart.type === 'hbar' ? <HBars points={chart.points} valueKey={series[0].key} unit={series[0].label.toLowerCase()} />
        : chart.type === 'segments' ? <Segments points={chart.points} />
        : <Compare points={chart.points} series={series} />}
      {chart.note && <p className="mt-2 text-xs text-slate-500">{chart.note}</p>}
    </Card>
  )
}
