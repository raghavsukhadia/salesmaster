import { useState } from 'react'
import { api, ApiError } from '../../auth'
import { Badge, fmtDate, flatten, Modal, Pager, useApi, useDebounced, qs } from '../../components/ui'

interface Product { id: number; name: string; category: string; description: string; is_active: boolean; updated_at: string }
interface Resp { summary: { total: number; active: number; inactive: number }; count: number; page_size: number; results: Product[] }
interface ImportResult { created: number; skipped_count: number; skipped_duplicates: string[]; invalid_count: number; invalid_rows: number[] }

const btn = 'rounded-lg border bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-50 disabled:opacity-50'
const input = 'w-full rounded-lg border px-3 py-2 text-sm'
const errText = (e: unknown) => (e instanceof ApiError ? flatten(e.data).join(' · ') || 'Request failed' : 'Network error. Please try again.')

function ProductModal({ product, onClose, onDone }: { product: Product | null; onClose: () => void; onDone: (msg: string) => void }) {
  const [f, setF] = useState({ name: product?.name ?? '', category: product?.category ?? '', description: product?.description ?? '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setErr('')
    try {
      await api(product ? `/api/management/products/${product.id}/` : '/api/management/products/', { method: product ? 'PATCH' : 'POST', body: f })
      onDone(product ? 'Product updated.' : 'Product added.')
    } catch (x) {
      setErr(errText(x))
      setBusy(false)
    }
  }

  return (
    <Modal title={product ? 'Edit product' : 'Add product'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3 whitespace-normal">
        {err && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{err}</p>}
        <label className="block text-xs text-slate-600">Product name<input required maxLength={200} autoFocus className={input} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label className="block text-xs text-slate-600">Category<input maxLength={100} className={input} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} /></label>
        <label className="block text-xs text-slate-600">Description<textarea rows={3} className={input} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className={btn}>Cancel</button>
          <button disabled={busy} className="rounded-lg bg-primary hover:bg-primary-hover px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{busy ? 'Saving…' : product ? 'Save changes' : 'Add product'}</button>
        </div>
      </form>
    </Modal>
  )
}

function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [result, setResult] = useState<ImportResult | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!file || busy) return
    setBusy(true)
    setErr('')
    const body = new FormData()
    body.append('file', file)
    try {
      setResult(await api<ImportResult>('/api/management/products/import/', { method: 'POST', body }))
      onDone()
    } catch (x) {
      setErr(errText(x))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Import products" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3 whitespace-normal">
        <p className="text-sm text-slate-500">Upload an Excel (.xlsx) or CSV file. The first row must have a <b>Name</b> column; <b>Category</b> and <b>Description</b> are optional. Existing product names are skipped, never overwritten.</p>
        {err && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{err}</p>}
        {result && (
          <div role="status" className="space-y-1 rounded-lg bg-green-50 p-3 text-sm text-green-800">
            <p><b>{result.created}</b> added.{result.skipped_count > 0 && <> {result.skipped_count} already existed and were skipped.</>}{result.invalid_count > 0 && <> {result.invalid_count} invalid row{result.invalid_count > 1 ? 's' : ''} (rows {result.invalid_rows.join(', ')}).</>}</p>
          </div>
        )}
        <input type="file" accept=".xlsx,.csv" aria-label="Product file" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setResult(null) }} className="block w-full text-sm" />
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className={btn}>{result ? 'Close' : 'Cancel'}</button>
          {!result && <button disabled={!file || busy} className="rounded-lg bg-primary hover:bg-primary-hover px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{busy ? 'Importing…' : 'Import'}</button>}
        </div>
      </form>
    </Modal>
  )
}

export default function Products() {
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const [n, setN] = useState(0)
  const dq = useDebounced(q)
  const { data, loading, error } = useApi<Resp>(`/api/management/products/?${qs({ q: dq, status, page })}&_=${n}`)
  const [edit, setEdit] = useState<Product | 'new' | null>(null)
  const [importing, setImporting] = useState(false)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const refresh = () => setN((v) => v + 1)

  async function toggle(p: Product) {
    if (busyId) return
    setBusyId(p.id)
    setMsg(null)
    try {
      await api(`/api/management/products/${p.id}/`, { method: 'PATCH', body: { is_active: !p.is_active } })
      setMsg({ ok: true, text: `${p.name} ${p.is_active ? 'deactivated' : 'activated'}.` })
      refresh()
    } catch (x) {
      setMsg({ ok: false, text: errText(x) })
    } finally {
      setBusyId(null)
    }
  }

  const s = data?.summary
  return (
    <>
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-[28px] font-semibold tracking-tight">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden><path d="M21 8 12 3 3 8v8l9 5 9-5z" /><path d="m3 8 9 5 9-5M12 13v8" /></svg>
            Products
          </h1>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setImporting(true)} className={`${btn} flex items-center gap-2 rounded-xl px-4 py-2.5`}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M12 15V3m0 0L7 8m5-5 5 5M4 17v3h16v-3" /></svg>Import
          </button>
          <button onClick={() => setEdit('new')} className="rounded-xl bg-primary hover:bg-primary-hover px-4 py-2.5 text-sm font-medium text-white">+ Add Product</button>
        </div>
      </div>

      <div className="mb-6 grid grid-cols-3 gap-4">
        {([['Total Products', s?.total], ['Active Products', s?.active], ['Inactive Products', s?.inactive]] as const).map(([l, v]) => (
          <div key={l} className="rounded-2xl border p-5">
            <div className="text-sm text-slate-600">{l}</div>
            <div className="mt-3 text-2xl font-semibold">{v ?? '—'}</div>
          </div>
        ))}
      </div>

      <div className="mb-5 flex items-end gap-4">
        <label className="flex-1 text-sm font-medium">Search products
          <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1) }} placeholder="Search name, category or description…" className="mt-2 w-full rounded-lg border px-3 py-2 text-sm font-normal" />
        </label>
        <label className="text-sm font-medium">Status
          <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }} className="mt-2 block rounded-lg border bg-white px-3 py-2 text-sm font-normal">
            <option value="">All</option><option value="active">Active</option><option value="inactive">Inactive</option>
          </select>
        </label>
      </div>

      {msg && <p role={msg.ok ? 'status' : 'alert'} className={`mb-3 rounded-lg p-3 text-sm ${msg.ok ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-700'}`}>{msg.text}</p>}
      {data && <p className="mb-4 text-sm text-slate-500">Showing {data.results.length} of {data.count} product{data.count === 1 ? '' : 's'}</p>}

      <div className="overflow-hidden rounded-2xl border">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50"><tr>{['Product Name', 'Category', 'Description', 'Status', 'Last Updated'].map((h) => <th key={h} className="px-4 py-3 font-medium">{h}</th>)}<th className="px-4 py-3 text-right font-medium">Actions</th></tr></thead>
          <tbody className="divide-y">
            {!loading && !error && data?.results.map((p) => (
              <tr key={p.id}>
                <td className="px-4 py-4 font-medium">{p.name}</td>
                <td className="px-4 text-slate-600">{p.category || '—'}</td>
                <td className="max-w-xs truncate px-4 text-slate-600" title={p.description}>{p.description || '—'}</td>
                <td className="px-4"><Badge tone={p.is_active ? 'green' : 'gray'}>{p.is_active ? 'Active' : 'Inactive'}</Badge></td>
                <td className="px-4 text-slate-500">{fmtDate(p.updated_at)}</td>
                <td className="px-4"><div className="flex justify-end gap-2">
                  <button className={`${btn} px-2.5 py-1 text-xs`} onClick={() => setEdit(p)}>Edit</button>
                  <button className={`${btn} px-2.5 py-1 text-xs`} disabled={busyId === p.id} onClick={() => toggle(p)}>{p.is_active ? 'Deactivate' : 'Activate'}</button>
                </div></td>
              </tr>
            ))}
          </tbody>
        </table>
        {loading && <p className="p-6 text-center text-slate-500">Loading…</p>}
        {error && <p role="alert" className="p-6 text-center text-red-600">Could not load products. Please refresh.</p>}
        {!loading && !error && data?.results.length === 0 && <p className="p-6 text-center text-slate-500">{q || status ? 'No products match your filters.' : 'No products yet. Add one or import a spreadsheet.'}</p>}
      </div>
      {data && <Pager page={page} count={data.count} onChange={setPage} size={data.page_size} />}

      {edit && <ProductModal product={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onDone={(text) => { setEdit(null); setMsg({ ok: true, text }); refresh() }} />}
      {importing && <ImportModal onClose={() => setImporting(false)} onDone={refresh} />}
    </>
  )
}
