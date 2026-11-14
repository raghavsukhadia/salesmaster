import { useState } from 'react'
import { Navigate, useOutletContext, useParams } from 'react-router-dom'
import { api, ApiError } from '../../auth'
import { useCrumb } from '../../components/crumbs'
import { Button, fieldErrors, Field, Modal, useApi, useToast } from '../../components/ui'
import { fmtCell } from './format'
import { isEnabledReport } from './reportNav'
import ReportView from './ReportView'
import { useReportParams } from './useReportParams'
import type { Report, ReportCtx, Row } from './types'

/** Edits a salesman's monthly order and visit targets through the existing salesman API. */
function TargetModal({ row, month, onClose, onSaved }: { row: Row; month: string; onClose: () => void; onSaved: () => void }) {
  const toast = useToast()
  const [orders, setOrders] = useState(String(row.order_target ?? 0))
  const [visits, setVisits] = useState(String(row.visit_target ?? 0))
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const whole = (v: string) => /^\d{1,6}$/.test(v) && Number(v) <= 100000

  async function save(e: React.FormEvent) {
    e.preventDefault()
    const bad: Record<string, string> = {}
    if (!whole(orders)) bad.monthly_order_target = 'Enter a whole number from 0 to 100000'
    if (!whole(visits)) bad.monthly_visit_target = 'Enter a whole number from 0 to 100000'
    setErrors(bad)
    if (Object.keys(bad).length) return
    setBusy(true)
    try {
      await api(`/api/management/salesmen/${row.id}/`, { method: 'PATCH', body: { monthly_order_target: Number(orders), monthly_visit_target: Number(visits) } })
      toast(`Targets saved for ${row.name}`)
      onSaved()
    } catch (err) {
      if (err instanceof ApiError) setErrors(fieldErrors(err.data))
      toast('Could not save the targets.', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={`Targets for ${row.name}`} onClose={onClose}>
      <form onSubmit={save} className="flex flex-col gap-4">
        <p className="text-sm text-slate-600">Each salesman has one standing monthly target, so this applies to every month, not only {month}. Enter 0 for no target.</p>
        <Field label="Orders per month" error={errors.monthly_order_target} hint="An order is a visit that recorded at least one product.">
          {(p) => <input {...p} inputMode="numeric" value={orders} onChange={(e) => setOrders(e.target.value)} autoFocus />}
        </Field>
        <Field label="Visits per month" error={errors.monthly_visit_target}>
          {(p) => <input {...p} inputMode="numeric" value={visits} onChange={(e) => setVisits(e.target.value)} />}
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={busy}>Save targets</Button>
        </div>
      </form>
    </Modal>
  )
}

function Loaded({ slug, id }: { slug: string; id?: string }) {
  const { me } = useOutletContext<ReportCtx>()
  const { params } = useReportParams()
  const [editing, setEditing] = useState<Row | null>(null)

  const rep = useApi<Report>(`/api/reports/${slug}/${id ? `${id}/` : ''}?${params}`)
  const expected = id ? (slug === 'salesman-wise' ? 'salesman-detail' : 'dealer-detail') : slug
  // While another report's data is still in memory (just after switching tabs), show the loading state instead.
  const data = rep.data?.report === expected ? rep.data : null
  useCrumb(id ? data?.title : undefined)

  const canEditTargets = slug === 'sales-targets' && me.role !== 'salesman'
  const month = data?.options.find((o) => o.key === 'month')?.value
  return (
    <>
      <ReportView data={data} loading={rep.loading} error={rep.error} onRetry={rep.reload}
        rowAction={canEditTargets ? { table: 'targets', label: 'Edit targets', onClick: setEditing } : undefined} />
      {editing && <TargetModal row={editing} month={fmtCell('month', month)} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); rep.reload() }} />}
    </>
  )
}

/** Every report except Compare: `/reports/:slug`, plus the salesman and dealer drill-downs at `/reports/:slug/:id`. */
export default function ReportPage() {
  const { slug = '', id } = useParams()
  const known = slug !== 'compare' && isEnabledReport(slug) // a disabled report (or a typed URL for one) goes back to the Overview
  const drill = slug === 'salesman-wise' || slug === 'dealer-wise'
  if (!known || (id && !drill)) return <Navigate to="/reports/overview" replace />
  return <Loaded key={`${slug}/${id ?? ''}`} slug={slug} id={id} />
}
