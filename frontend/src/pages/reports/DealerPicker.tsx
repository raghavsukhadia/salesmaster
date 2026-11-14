import { useCallback, useEffect, useState } from 'react'
import { api } from '../../auth'
import SearchSelect, { type Opt } from './SearchSelect'

interface DealerOpt { id: number; name: string; location: string }
const toOpt = (d: DealerOpt): Opt => ({ value: String(d.id), label: d.name, hint: d.location })

/** Dealer chooser backed by `/api/reports/dealer-options/`, which only ever returns dealers the signed-in user may see. */
export default function DealerPicker({ label, value, onChange }: { label: string; value: string; onChange: (id: string) => void }) {
  const [options, setOptions] = useState<Opt[]>([])
  const [name, setName] = useState('')

  // A dealer arriving from the URL has an id but no name yet: look it up.
  useEffect(() => {
    if (!value) return
    let live = true
    api<DealerOpt[]>(`/api/reports/dealer-options/?id=${value}`).then((r) => { if (live && r[0]) setName(r[0].name) }).catch(() => {})
    return () => { live = false }
  }, [value])

  const search = useCallback((q: string) => {
    api<DealerOpt[]>(`/api/reports/dealer-options/?q=${encodeURIComponent(q)}`).then((r) => setOptions(r.map(toOpt))).catch(() => setOptions([]))
  }, [])

  return (
    <SearchSelect label={label} value={value} selectedLabel={name || undefined} options={options} onQuery={search} allLabel="All dealers"
      placeholder="Search by name, phone or city" onChange={(v, l) => { setName(l); onChange(v) }} />
  )
}
