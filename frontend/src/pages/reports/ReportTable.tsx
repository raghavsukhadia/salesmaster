import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { Badge, Card, Pager, SearchBox, Table, useDebounced, type Column, type Tone } from '../../components/ui'
import { compareCells, fillPath, fmtCell, fmtChange, isNumeric } from './format'
import { useReportParams } from './useReportParams'
import type { Col, Kind, Row, Tbl } from './types'

const PAGE = 25
const BADGE: Record<string, Tone> = { New: 'green', Repeat: 'blue', 'Never ordered': 'red', Idle: 'amber' }

const kindOf = (c: Col, row: Row): Kind => (c.kind === 'mixed' ? ((row.kind as Kind) ?? 'int') : c.kind)

export function Change({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) return <span className="text-slate-400">—</span>
  if (value === 0) return <span className="text-slate-600">0%</span>
  // Direction is carried by the arrow and the sign as well as the colour, so it never relies on colour alone.
  return value > 0
    ? <span className="inline-flex items-center gap-1 font-medium text-[#006300]"><ArrowUp size={12} aria-hidden />{fmtChange(value)}</span>
    : <span className="inline-flex items-center gap-1 font-medium text-red-700"><ArrowDown size={12} aria-hidden />{fmtChange(value)}</span>
}

function Cell({ col, row }: { col: Col; row: Row }) {
  const v = row[col.key]
  const kind = kindOf(col, row)
  const text = fmtCell(col.kind, v, row)
  if (col.link && v !== '' && v !== null && v !== undefined) {
    const to = `${fillPath(col.link.path, row)}${col.link.search ? `?${col.link.search}` : ''}`
    return <Link to={to} className="font-medium text-primary hover:underline">{text}</Link>
  }
  if (kind === 'badge') return text ? <Badge tone={BADGE[text] ?? 'gray'}>{text}</Badge> : null
  if (kind === 'change') return <Change value={typeof v === 'number' ? v : null} />
  if (kind === 'rank') return <span className="inline-grid size-6 place-items-center rounded-full bg-primary-soft text-xs font-semibold text-primary">{text}</span>
  if (kind === 'target' && !v) return <span className="text-slate-400">No target</span>
  return <>{text}</>
}

interface Props {
  table: Tbl
  /** An extra last column with one button per row (used by Sales Targets to edit a salesman's targets). */
  rowAction?: { label: string; onClick: (row: Row) => void }
}

export default function ReportTable({ table, rowAction }: Props) {
  const { params, setParam } = useReportParams()
  const server = !!table.server
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null)
  const [page, setPage] = useState(1)

  // Server-side search (the order list): the box edits the `q` URL param after a short pause.
  const [serverQ, setServerQ] = useState(params.get('q') ?? '')
  const debounced = useDebounced(serverQ, 350)
  useEffect(() => { if (server && debounced !== (params.get('q') ?? '')) setParam('q', debounced) }, [server, debounced, params, setParam])

  const rows = useMemo(() => {
    if (server) return table.rows
    const needle = q.trim().toLowerCase()
    let out = needle
      ? table.rows.filter((r) => table.columns.some((c) => fmtCell(c.kind, r[c.key], r).toLowerCase().includes(needle)))
      : table.rows
    if (sort) {
      const dir = sort.dir === 'asc' ? 1 : -1
      out = [...out].sort((a, b) => dir * compareCells(a[sort.key], b[sort.key]))
    }
    return out
  }, [table, q, sort, server])

  const shown = server ? rows : rows.slice((page - 1) * PAGE, page * PAGE)
  const toggle = (key: string) => {
    setPage(1)
    setSort((s) => (s?.key !== key ? { key, dir: 'asc' } : s.dir === 'asc' ? { key, dir: 'desc' } : null))
  }

  const head: Column[] = [
    ...table.columns.map((c): Column => ({
      label: c.label, right: isNumeric(c.kind),
      ...(server || table.rows.length < 2 ? {} : { onSort: () => toggle(c.key), sorted: sort?.key === c.key ? sort.dir : null }),
    })),
    ...(rowAction ? [{ label: 'Actions' } as Column] : []),
  ]
  const showSearch = server || (table.search && table.rows.length > 8)
  const total = server ? table.total : rows.length
  const capped = !server && table.total > table.rows.length

  return (
    <Card className="p-4 print:break-inside-avoid-page">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-semibold text-slate-900">{table.title}</h3>
          <p className="text-xs text-slate-500">
            {table.subtitle && `${table.subtitle} · `}{total.toLocaleString('en-IN')} {total === 1 ? 'row' : 'rows'}
            {q && !server ? ` match “${q}”` : ''}
          </p>
        </div>
      </div>
      {showSearch && (
        <div className="print:hidden">
          <SearchBox value={server ? serverQ : q} onChange={(v) => { if (server) setServerQ(v); else { setQ(v); setPage(1) } }}
            placeholder={server ? 'Search orders by dealer, salesman, product or order number' : `Search ${table.title.toLowerCase()}`} />
        </div>
      )}
      <Table head={head} empty={shown.length === 0} emptyTitle="Nothing to show" emptyHint={q || serverQ ? 'No rows match your search.' : 'No data for these filters.'}>
        {shown.map((r, i) => (
          <tr key={i}>
            {table.columns.map((c) => (
              <td key={c.key} className={isNumeric(c.kind) ? 'text-right tabular-nums' : c.key === 'items' || c.key === 'top_products' || c.key === 'notes' ? 'min-w-56 max-w-md' : ''}>
                <Cell col={c} row={r} />
              </td>
            ))}
            {rowAction && <td><button type="button" onClick={() => rowAction.onClick(r)} className="rounded-md px-2 py-1 text-sm font-medium text-primary hover:bg-primary-soft print:hidden">{rowAction.label}</button></td>}
          </tr>
        ))}
        {table.totals && shown.length > 0 && (
          <tr className="bg-slate-50 font-semibold">
            {table.columns.map((c) => (
              <td key={c.key} className={isNumeric(c.kind) ? 'text-right tabular-nums' : ''}>{table.totals![c.key] !== undefined ? fmtCell(c.kind, table.totals![c.key], table.totals!) : ''}</td>
            ))}
            {rowAction && <td />}
          </tr>
        )}
      </Table>
      {capped && <p className="mt-2 text-xs text-slate-500">Showing the first {table.rows.length.toLocaleString('en-IN')} of {table.total.toLocaleString('en-IN')}. Narrow the filters or download the Excel file for every row.</p>}
      <div className="print:hidden">
        {server
          ? <Pager page={table.page ?? 1} count={table.total} size={table.page_size ?? PAGE} onChange={(p) => setParam('page', String(p))} />
          : <Pager page={page} count={rows.length} size={PAGE} onChange={setPage} />}
      </div>
    </Card>
  )
}
