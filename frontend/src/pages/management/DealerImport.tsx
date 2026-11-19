import { useState } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import { Download, FileUp } from 'lucide-react'
import { api, ApiError, type Me } from '../../auth'
import { Button, buttonClass, Card, flatten, PageHeader, Select, useApi } from '../../components/ui'

interface Options { salesmen: { id: number; name: string; active: boolean }[] }
interface Result {
  created: number; assigned: number; unassigned: number
  skipped_count: number; skipped_duplicates: string[]
  invalid_count: number; invalid_rows: { row: number; reason: string }[]
}

const COLUMNS = ['Name', 'Phone', 'WhatsApp', 'Address', 'City', 'State', 'Pincode', 'GST', 'Salesman']
const errText = (e: unknown) => (e instanceof ApiError ? flatten(e.data).join(' · ') || 'Import failed' : 'Network error. Please try again.')

/** A ready-to-fill CSV with the right headers and one example row. */
function downloadTemplate() {
  const csv = `${COLUMNS.join(',')}\nXYZ Motors,9876543210,,"Shop 3, MG Road",Pune,Maharashtra,411001,,\n`
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
  a.download = 'dealers-template.csv'
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

/** Management > Import Dealers: add dealers from a sheet; each can go straight into a salesman's My Dealers. */
export default function DealerImport() {
  const { me } = useOutletContext<{ me: Me }>()
  const { data } = useApi<Options>('/api/management/scope-options/')
  const [file, setFile] = useState<File | null>(null)
  const [sid, setSid] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [result, setResult] = useState<Result | null>(null)
  const [inputKey, setInputKey] = useState(0)

  if (me.role !== 'admin') {
    return <><PageHeader title="Import Dealers" /><Card className="p-6 text-sm text-slate-600">Only an admin can import dealers.</Card></>
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!file || busy) return
    setBusy(true); setErr(''); setResult(null)
    const body = new FormData()
    body.append('file', file)
    if (sid) body.append('salesman_id', sid)
    try {
      setResult(await api<Result>('/api/management/dealers/import/', { method: 'POST', body }))
      setFile(null); setInputKey((k) => k + 1)
    } catch (x) {
      setErr(errText(x))
    } finally {
      setBusy(false)
    }
  }

  const owner = data?.salesmen.find((s) => String(s.id) === sid)?.name
  return (
    <>
      <PageHeader title="Import Dealers" subtitle="Add many dealers at once from an Excel or CSV file."
        action={<Link to="/dealers" className={buttonClass('secondary')}>Back to Dealers</Link>} />
      <div className="max-w-3xl">
        <Card className="p-4 sm:p-6">
          <form onSubmit={submit} className="space-y-4">
            <Select label="Assign imported dealers to" value={sid} onChange={setSid}>
              <option value="">Nobody (leave unassigned)</option>
              {data?.salesmen.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
            {owner && (
              <p className="-mt-2 text-xs text-slate-500">
                They will appear in <b>{owner}</b>’s My Dealers right away.
              </p>
            )}
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">Dealer file (.xlsx or .csv)
              <input key={inputKey} type="file" accept=".xlsx,.csv" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setResult(null); setErr('') }}
                className="block w-full rounded-lg border bg-white p-2 text-sm text-slate-900 file:mr-3 file:rounded-md file:border-0 file:bg-primary-soft file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-primary" />
            </label>
            {err && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{err}</p>}
            {result && (
              <div role="status" className="space-y-2 rounded-lg bg-green-50 p-3 text-sm text-green-900">
                <p><b>{result.created}</b> dealer{result.created === 1 ? '' : 's'} added
                  {result.assigned > 0 && <>, <b>{result.assigned}</b> assigned to a salesman</>}
                  {result.unassigned > 0 && <>, {result.unassigned} unassigned</>}.</p>
                {result.skipped_count > 0 && <p className="text-amber-800">{result.skipped_count} skipped because the phone number already belongs to a dealer: {result.skipped_duplicates.join(', ')}{result.skipped_count > result.skipped_duplicates.length && '…'}</p>}
                {result.invalid_count > 0 && (
                  <div className="text-red-700"><p>{result.invalid_count} row{result.invalid_count === 1 ? '' : 's'} not imported:</p>
                    <ul className="ml-4 list-disc">{result.invalid_rows.map((r) => <li key={r.row}>Row {r.row}: {r.reason}</li>)}</ul>
                  </div>
                )}
                <Link to="/dealers" className="inline-block font-medium underline">View dealers</Link>
              </div>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="secondary" onClick={downloadTemplate}><Download size={16} aria-hidden />Download template</Button>
              <Button type="submit" loading={busy} disabled={!file}>{!busy && <FileUp size={16} aria-hidden />}{busy ? 'Importing…' : 'Import dealers'}</Button>
            </div>
          </form>
        </Card>
      </div>
    </>
  )
}
