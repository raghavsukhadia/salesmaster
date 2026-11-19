import { useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { GitCompareArrows } from 'lucide-react'
import { Card, DropdownSelect, EmptyState, Pills, useApi } from '../../components/ui'
import DealerPicker from './DealerPicker'
import { COMPARE_KINDS, validCompareValue } from './filters'
import { fmtMonth } from './format'
import ReportView from './ReportView'
import SearchSelect from './SearchSelect'
import { useReportParams } from './useReportParams'
import type { Report, ReportCtx } from './types'

/** Two date inputs that only commit once they form a valid range, stored as 'YYYY-MM-DD..YYYY-MM-DD'. */
function RangeInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [from0, to0] = value.split('..')
  const [draft, setDraft] = useState({ from: from0 ?? '', to: to0 ?? '' })
  const set = (next: { from: string; to: string }) => {
    setDraft(next)
    const v = `${next.from}..${next.to}`
    if (validCompareValue('range', v)) onChange(v)
  }
  const bad = draft.from && draft.to && draft.to < draft.from
  const cls = 'h-10 w-full rounded-lg border bg-white px-3 text-sm font-normal text-slate-900'
  return (
    <fieldset>
      <legend className="mb-1 text-xs font-medium text-slate-600">{label}</legend>
      <div className="grid grid-cols-2 gap-2">
        <label className="sr-only" htmlFor={`${label}-from`}>{label} from</label>
        <input id={`${label}-from`} type="date" value={draft.from} onChange={(e) => set({ ...draft, from: e.target.value })} className={cls} max={draft.to || undefined} />
        <label className="sr-only" htmlFor={`${label}-to`}>{label} to</label>
        <input id={`${label}-to`} type="date" value={draft.to} onChange={(e) => set({ ...draft, to: e.target.value })} className={cls} min={draft.from || undefined} aria-invalid={bad || undefined} />
      </div>
      {bad && <p role="alert" className="mt-1 text-xs text-red-600">The end date is before the start date.</p>}
    </fieldset>
  )
}

function Side({ kind, label, value, onChange, ctx }: { kind: string; label: string; value: string; onChange: (v: string) => void; ctx: ReportCtx }) {
  const o = ctx.options
  if (kind === 'salesman') {
    return <DropdownSelect label={label} value={value} onChange={onChange}
      options={[{ value: '', label: 'Choose a salesman' }, ...(o?.salesmen ?? []).map((s) => ({ value: String(s.id), label: s.name }))]} />
  }
  if (kind === 'product') {
    return <SearchSelect label={label} value={value} allLabel="Choose a product" placeholder="Search products" onChange={(v) => onChange(v)}
      options={(o?.products ?? []).map((p) => ({ value: p.value, label: p.label, hint: p.custom ? 'Custom item' : p.category }))} />
  }
  if (kind === 'dealer') return <DealerPicker label={label} value={value} onChange={onChange} />
  if (kind === 'month') {
    return <DropdownSelect label={label} value={value} onChange={onChange}
      options={[{ value: '', label: 'Choose a month' }, ...(o?.months ?? []).map((m) => ({ value: m, label: fmtMonth(m) }))]} />
  }
  return <RangeInput label={label} value={value} onChange={onChange} />
}

function Results() {
  const { params } = useReportParams()
  const rep = useApi<Report>(`/api/reports/compare/?${params}`)
  const data = rep.data?.report === 'compare' ? rep.data : null
  return <ReportView data={data} loading={rep.loading} error={rep.error} onRetry={rep.reload} />
}

/** Advanced comparison: two salesmen, products, dealers, months or date ranges, with percentage growth or decline from A to B. */
export default function ComparePage() {
  const ctx = useOutletContext<ReportCtx>()
  const { params, setMany } = useReportParams()
  const management = ctx.me.role !== 'salesman'
  const kinds = COMPARE_KINDS.filter(([k]) => management || k !== 'salesman')
  const kind = kinds.some(([k]) => k === params.get('type')) ? params.get('type')! : ''
  const a = params.get('a') ?? ''
  const b = params.get('b') ?? ''
  const ready = !!kind && validCompareValue(kind, a) && validCompareValue(kind, b)
  const noun = COMPARE_KINDS.find(([k]) => k === kind)?.[1].replace('Two ', '') ?? ''

  return (
    <>
      <Card className="mb-6 p-4">
        <div className="mb-4">
          <div className="mb-1 text-xs font-medium text-slate-600">What do you want to compare?</div>
          <Pills value={kind} options={kinds.map(([k, l]) => [k, l] as [string, string])} onChange={(k) => setMany({ type: k, a: '', b: '' })} />
        </div>
        {kind && (
          // Keyed by kind so switching between kinds starts the pickers fresh.
          <div key={kind} className="grid gap-4 sm:grid-cols-2">
            <Side kind={kind} label="A (the starting point)" value={a} onChange={(v) => setMany({ a: v })} ctx={ctx} />
            <Side kind={kind} label="B (compared with A)" value={b} onChange={(v) => setMany({ b: v })} ctx={ctx} />
          </div>
        )}
      </Card>
      {ready ? <Results /> : (
        <Card>
          <EmptyState icon={<GitCompareArrows size={20} aria-hidden />} title={kind ? `Choose two ${noun} to compare` : 'Choose what to compare'}
            hint={kind ? 'Growth or decline is shown from A to B. The other filters above apply to both sides.' : 'Pick salesman, products, dealers, months or date ranges above.'} />
        </Card>
      )}
    </>
  )
}
