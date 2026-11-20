import { useState } from 'react'
import { useApi } from '../components/ui'

interface CityOpt { city: string; state: string }

type InputProps = { id: string; className: string; 'aria-invalid'?: true; 'aria-describedby'?: string }

/**
 * Free-text city box that suggests the cities already saved on this salesman's dealers, so a city typed once is
 * offered again next time. Any new city can still be typed. Picking a suggestion passes its state along too.
 */
export default function CityInput({ value, onChange, onPick, ...input }: InputProps & {
  value: string
  onChange: (city: string) => void
  /** A suggestion was chosen: its city and the state it is usually saved with ("" when unknown). */
  onPick: (o: CityOpt) => void
}) {
  const { data } = useApi<CityOpt[]>('/api/salesman/cities/') // on failure it stays a plain text box
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)

  const needle = value.trim().toLowerCase()
  const matches = (data ?? []).filter((o) => o.city.toLowerCase().includes(needle) && o.city.toLowerCase() !== needle)
  const show = open && matches.length > 0
  const listId = `${input.id}-cities`

  function pick(o: CityOpt) { onPick(o); setOpen(false); setActive(0) }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((i) => Math.min(i + 1, matches.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter' && show && matches[active]) { e.preventDefault(); pick(matches[active]) }
    else if (e.key === 'Escape') setOpen(false)
  }

  return (
    <div className="relative">
      <input {...input} role="combobox" aria-expanded={show} aria-controls={listId} aria-autocomplete="list"
        aria-activedescendant={show && matches[active] ? `${listId}-${active}` : undefined}
        value={value} maxLength={80} autoComplete="off"
        onChange={(e) => { onChange(e.target.value); setActive(0); setOpen(true) }}
        onFocus={() => setOpen(true)} onClick={() => setOpen(true)} onBlur={() => setOpen(false)} onKeyDown={onKeyDown} />
      {show && (
        <ul id={listId} role="listbox" aria-label="Saved cities"
          className="absolute z-20 mt-1 max-h-60 w-full divide-y overflow-y-auto overscroll-contain rounded-lg border bg-white shadow-lg">
          {matches.map((o, i) => (
            <li key={o.city} id={`${listId}-${i}`} role="option" aria-selected={i === active}
              // mousedown would blur the input (closing the list) before the click lands
              onMouseDown={(e) => e.preventDefault()} onClick={() => pick(o)} onMouseEnter={() => setActive(i)}
              className={`flex cursor-pointer items-center justify-between gap-3 px-3 py-2.5 text-sm ${i === active ? 'bg-primary-soft' : ''}`}>
              <span className="min-w-0 truncate text-slate-900">{o.city}</span>
              {o.state && <span className="shrink-0 text-xs text-slate-500">{o.state}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
