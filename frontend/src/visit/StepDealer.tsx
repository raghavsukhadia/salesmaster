import { useEffect, useRef, useState } from 'react'
import { ArrowRight, CircleAlert, MapPin, ScanLine, Store, TextCursorInput } from 'lucide-react'
import { api, ApiError } from '../auth'
import { Button, Card, Field, fieldErrors, StateSelect } from '../components/ui'
import { GOOD_FIX_M, gpsMessage, isFresh, quickReading, type Reading } from '../field/gps.ts'
import { tracker } from '../field/useTracker'
import { CardImageError, readCard, type OcrPass } from './cardOcr.ts'
import { parseCardReads, type CardField } from './cardParser.ts'
import { CARD_DRAFT_KEYS, draftPayload, EMPTY_DRAFT, hasLocation, LOCATION_KEYS, validateDraft, type DealerDraft } from './dealerDraft.ts'
import CityInput from './CityInput'
import DealerPicker from './DealerPicker'
import ScanPanel from './ScanPanel'
import { addShot, canRead, removeShot } from './scanShots.ts'
import type { Chosen, DealerLite, DealerMode, DealerState } from './types.ts'

const TABS: { mode: DealerMode; label: string; icon: typeof ScanLine }[] = [
  { mode: 'scan', label: 'Scan Card', icon: ScanLine },
  { mode: 'manual', label: 'Enter Manually', icon: TextCursorInput },
  { mode: 'existing', label: 'Existing Dealer', icon: Store },
]

type Update = (patch: Partial<DealerState> | ((s: DealerState) => Partial<DealerState>)) => void

/** Fields read off the card are tinted so the salesman knows which values to double-check. */
const tint = (filled: Set<CardField>, k: CardField) => (filled.has(k) ? 'bg-accent-soft!' : '') // "!": the input's own bg-white would otherwise win


/** "Detect current location": one tap takes a fresh GPS fix at the shop and keeps it on the draft. Saved with the dealer, unverified. */
function LocationField({ draft, set, error }: { draft: DealerDraft; set: (k: keyof DealerDraft, v: string) => void; error?: string }) {
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const has = hasLocation(draft)
  const accuracy = Number(draft.location_accuracy_m)

  // Warm the GPS as soon as the form opens (only if location is already allowed, so no surprise prompt),
  // so the button usually answers instantly instead of waiting for a cold fix.
  const warm = useRef<Reading | null>(null)
  useEffect(() => {
    let live = true
    navigator.permissions?.query({ name: 'geolocation' }).then((s) => {
      if (live && s.state === 'granted') quickReading({ latest: tracker.getState().position }).then((r) => { if (live) warm.current = r }, () => {})
    }, () => {})
    return () => { live = false }
  }, [])

  async function detect() {
    setBusy(true); setProblem('')
    try {
      const w = warm.current
      warm.current = null
      // Fast: uses the warmed or tracker fix when it is under 15 s old, so it is still where the salesman stands.
      const r = w && w.accuracy_m <= GOOD_FIX_M && isFresh(Date.parse(w.captured_at)) ? w : await quickReading({ latest: tracker.getState().position })
      set('latitude', r.latitude.toFixed(6)); set('longitude', r.longitude.toFixed(6)); set('location_accuracy_m', String(r.accuracy_m))
    } catch (e) {
      setProblem(gpsMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div id="shop-location" className={`sm:col-span-2 rounded-lg border p-3 sm:p-4 ${error && !has ? 'border-red-300 bg-red-50' : 'bg-slate-50'}`}>
      <p className="text-sm font-medium text-slate-700">Shop location <span className="text-red-600" aria-hidden>*</span><span className="sr-only">(required)</span></p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <Button variant="secondary" onClick={detect} loading={busy}>
          {!busy && <MapPin size={16} aria-hidden />}{busy ? 'Detecting…' : has ? 'Detect again' : 'Detect current location'}
        </Button>
        {has && !busy && <Button variant="secondary" onClick={() => LOCATION_KEYS.forEach((k) => set(k, ''))}>Clear</Button>}
      </div>
      <div role="status" aria-live="polite">
        {has && !busy && !problem && (
          <p className="mt-3 text-sm text-green-700">
            Location captured ({Number(draft.latitude).toFixed(5)}, {Number(draft.longitude).toFixed(5)}){Number.isFinite(accuracy) && draft.location_accuracy_m && `, accurate to about ${Math.round(accuracy)} m`}
          </p>
        )}
        {has && !busy && !problem && accuracy > GOOD_FIX_M && ( // a fix this rough is probably indoors or on cell towers: still accepted, but the salesman is told
          <p className="mt-1 text-xs text-amber-700">This reading is rough. Step outside or near a window and tap Detect again for a better one.</p>
        )}
        {problem && <p className="mt-3 text-sm text-red-700">{problem} The shop location is required to continue.</p>}
        {error && !has && !problem && !busy && <p role="alert" className="mt-3 text-sm font-medium text-red-700">{error}</p>}
      </div>
    </div>
  )
}

function DealerFields({ draft, set, errors, filled }: { draft: DealerDraft; set: (k: keyof DealerDraft, v: string) => void; errors: Record<string, string>; filled: Set<CardField> }) {
  const text = (k: keyof DealerDraft, extra: React.InputHTMLAttributes<HTMLInputElement> = {}) => (p: { className: string } & React.InputHTMLAttributes<HTMLInputElement>) => (
    <input {...p} {...extra} className={`${p.className} ${tint(filled, k as CardField)}`} value={draft[k]} onChange={(e) => set(k, e.target.value)} />
  )
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="sm:col-span-2"><Field label="Business name *" error={errors.name}>{text('name', { autoComplete: 'off', maxLength: 200 })}</Field></div>
      <div className="sm:col-span-2"><Field label="Phone *" error={errors.phone}>{text('phone', { type: 'tel', inputMode: 'tel', autoComplete: 'off', maxLength: 20 })}</Field></div>
      <LocationField draft={draft} set={set} error={errors.location} />
      <Field label="City *" error={errors.city}>
        {(p) => <CityInput {...p} className={`${p.className} ${tint(filled, 'city')}`} value={draft.city} onChange={(v) => set('city', v)}
          onPick={(o) => { set('city', o.city); if (o.state && !draft.state) set('state', o.state) }} />}
      </Field>
      <Field label="State *" error={errors.state}>
        {(p) => <StateSelect id={p.id} value={draft.state} onChange={(v) => set('state', v)} className={`${p.className} ${tint(filled, 'state')}`} />}
      </Field>
      <Field label="Pincode *" error={errors.pincode}>{text('pincode', { inputMode: 'numeric', maxLength: 6, autoComplete: 'off' })}</Field>
      <div className="sm:col-span-2">
        <Field label="Address *" error={errors.address}>
          {(p) => <textarea {...p} rows={2} value={draft.address} onChange={(e) => set('address', e.target.value)} className={`${p.className} h-auto py-2 ${tint(filled, 'address')}`} />}
        </Field>
      </div>
    </div>
  )
}

export default function StepDealer({ state, update, onContinue }: { state: DealerState; update: Update; onContinue: (c: Chosen) => void }) {
  const { mode, draft, selected, scan } = state
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [note, setNote] = useState('')
  const [checking, setChecking] = useState(false)
  const [duplicate, setDuplicate] = useState<DealerLite | null>(null)
  const abort = useRef<AbortController | null>(null)

  // Leaving the screen stops a scan in progress.
  useEffect(() => () => { abort.current?.abort() }, [])

  const filled = new Set<CardField>(scan.filled ?? [])
  const set = (k: keyof DealerDraft, v: string) => {
    update((s) => ({ draft: { ...s.draft, [k]: v } }))
    const loc = (LOCATION_KEYS as readonly string[]).includes(k)
    if (errors[k] || errors._ || (loc && errors.location)) setErrors((e) => ({ ...e, [k]: '', _: '', ...(loc && { location: '' }) }))
    setDuplicate(null)
  }

  function setMode(m: DealerMode) {
    if (m === 'scan' && scan.phase === 'camera') return
    // Leaving the Scan tab while the camera is open closes it: it must never stay on in the background.
    update((s) => ({ mode: m, scan: s.scan.phase === 'camera' ? { ...s.scan, phase: 'idle' } : s.scan }))
    setErrors({}); setNote(''); setDuplicate(null)
  }

  /** A card photo arrived (camera or upload). After the front the salesman can read it or add the back; with both, reading starts by itself. */
  function addPhoto(photo: Blob) {
    const { shots, full } = addShot(scan.shots, photo)
    setErrors({}); setNote(''); setDuplicate(null)
    if (!full) return update({ scan: { phase: 'idle', shots } })
    void readPhotos(shots)
  }

  async function readPhotos(shots: Blob[]) {
    abort.current?.abort()
    const ctl = new AbortController()
    abort.current = ctl
    update({ scan: { phase: 'reading', shots, readingPhoto: 1, progress: { stage: 'preparing', progress: 0 } } })
    try {
      // Front then back, one after the other. Each photo is read several ways; all the reads are parsed and merged together.
      const photos: OcrPass[][] = []
      for (const [i, shot] of shots.entries()) {
        const reads = await readCard(shot, {
          signal: ctl.signal,
          onProgress: (progress) => { if (!ctl.signal.aborted) update((s) => ({ scan: { ...s.scan, progress, readingPhoto: i + 1 } })) },
        })
        if (ctl.signal.aborted) return
        photos.push(reads)
      }
      const { fields: found, text } = parseCardReads(photos)
      const keys = CARD_DRAFT_KEYS.filter((k) => found[k])
      if (!keys.length) {
        // Start over from photo 1: the photos that could not be read are dropped.
        update({ scan: { phase: 'error', shots: [], text, message: 'No dealer details could be read from these photos. Try again in better light with the card filling the frame, or enter the details by hand.' } })
        return
      }
      update((s) => {
        // A fresh scan after a scan replaces it; a first scan only fills fields the salesman has not typed into.
        // The shop location is where the salesman is standing, not something on the card, so a rescan keeps it.
        const base = s.scan.phase === 'done' || s.scan.filled ? { ...EMPTY_DRAFT, ...Object.fromEntries(LOCATION_KEYS.map((k) => [k, s.draft[k]])) } : s.draft
        const next = { ...base }
        for (const k of keys) if (!base[k]) next[k] = found[k]
        return { draft: next, scan: { phase: 'done', shots, text, filled: keys } }
      })
    } catch (e) {
      if (ctl.signal.aborted) return
      update({ scan: { phase: 'error', shots: [], message: e instanceof CardImageError ? e.message : 'The card could not be read. Try again, or enter the details by hand.' } })
    }
  }

  async function next() {
    setErrors({}); setNote(''); setDuplicate(null)
    if (mode === 'existing') {
      if (!selected) return setNote('Select one of your dealers to continue.')
      return onContinue({ kind: 'existing', dealer: selected })
    }
    if (mode === 'scan' && scan.phase !== 'done') return setNote(canRead(scan.shots?.length ?? 0) ? 'Tap "Read card now" first, or use Enter Manually.' : 'Take a photo of the front of the card first, or use Enter Manually.')
    const bad = validateDraft(draft)
    if (Object.keys(bad).length) return setErrors(bad)
    setChecking(true)
    try {
      const r = await api<{ duplicate: boolean; dealer?: DealerLite }>('/api/dealers/check-duplicate/', { method: 'POST', body: draftPayload(draft) })
      if (r.duplicate && r.dealer) return setDuplicate(r.dealer)
      onContinue({ kind: 'new', draft })
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setNote('A dealer with these details already exists but is not available to you. Ask your manager.')
      else if (e instanceof ApiError && e.status === 400) setErrors(fieldErrors(e.data))
      else if (e instanceof ApiError && e.status === 403) setNote('Your account cannot record visits. Contact your manager.')
      else setNote('Could not check whether this dealer already exists. Check your connection and try again.')
    } finally {
      setChecking(false)
    }
  }

  const showForm = mode === 'manual' || (mode === 'scan' && scan.phase === 'done')
  const messages = [errors._, note].filter(Boolean)
  const fieldProblems = Object.entries(errors).filter(([k, v]) => k !== '_' && v)
  const canContinue = mode === 'existing' ? !!selected : mode === 'manual' || scan.phase === 'done'

  return (
    <Card className="p-4 sm:p-6">
      <h2 className="text-lg font-semibold text-slate-900">Dealer details</h2>

      <div role="tablist" aria-label="How to identify the dealer" className="mt-4 grid grid-cols-3 gap-2">
        {TABS.map(({ mode: m, label, icon: Icon }) => (
          <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => setMode(m)}
            className={`flex min-h-[3.25rem] flex-col items-center justify-center gap-1 rounded-lg border px-2 py-2 text-xs font-medium transition-colors sm:flex-row sm:gap-2 sm:text-sm ${
              mode === m ? 'border-primary bg-primary text-white' : 'bg-white text-slate-700 hover:bg-slate-50'}`}>
            <Icon size={18} aria-hidden />{label}
          </button>
        ))}
      </div>

      <div role="tabpanel" className="mt-5 space-y-5">
        {mode === 'scan' && (
          <ScanPanel scan={scan} onFile={addPhoto} onRead={() => { if (canRead(scan.shots?.length ?? 0)) void readPhotos(scan.shots!) }}
            onRemoveShot={(i) => update((s) => ({ scan: { ...s.scan, shots: removeShot(s.scan.shots, i) } }))}
            onCameraOpen={() => update((s) => ({ scan: { ...s.scan, phase: 'camera', message: undefined } }))}
            onCameraClosed={() => update((s) => ({ scan: { ...s.scan, phase: s.scan.filled ? 'done' : 'idle' } }))}
            onCameraFailed={(message, cameraProblem) => update((s) => ({ scan: { ...s.scan, phase: 'error', message, cameraProblem } }))}
            onReset={() => update({ scan: { phase: 'idle' } })} />
        )}

        {mode === 'scan' && scan.phase === 'done' && (
          <p className="rounded-lg bg-accent-soft/60 p-3 text-xs text-accent-ink">
            {filled.size} {filled.size === 1 ? 'field was' : 'fields were'} read from the card (shaded below). OCR can misread letters and digits, so check each one.
          </p>
        )}

        {showForm && <DealerFields draft={draft} set={set} errors={errors} filled={filled} />}

        {mode === 'scan' && scan.phase === 'done' && scan.text && (
          <details className="rounded-lg border bg-slate-50 text-sm">
            <summary className="cursor-pointer select-none px-3 py-2 font-medium text-slate-700">Text read from the card</summary>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap border-t px-3 py-2 text-xs text-slate-600">{scan.text.trim()}</pre>
          </details>
        )}

        {mode === 'existing' && <DealerPicker selected={selected} onSelect={(d) => { update({ selected: d }); setNote('') }} />}
      </div>

      {duplicate && (
        <div role="alert" className="mt-5 flex flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm sm:flex-row sm:items-center sm:justify-between">
          <p className="text-amber-900">
            This dealer already exists: <strong>{duplicate.name}</strong>{duplicate.city && ` · ${duplicate.city}`}. Record the visit against that dealer instead of creating a duplicate.
          </p>
          <Button onClick={() => { update({ mode: 'existing', selected: duplicate }); setDuplicate(null) }}>Use this dealer</Button>
        </div>
      )}

      {(messages.length > 0 || fieldProblems.length > 0) && (
        <div role="alert" className="mt-5 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <CircleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
          <div>
            {messages.map((m) => <p key={m}>{m}</p>)}
            {fieldProblems.length > 0 && <p>Fix the highlighted {fieldProblems.length === 1 ? 'field' : 'fields'} to continue.</p>}
          </div>
        </div>
      )}

      <div className="mt-6 flex justify-end border-t pt-5">
        <Button onClick={next} loading={checking} disabled={!canContinue || scan.phase === 'reading'}>
          {checking ? 'Checking…' : 'Continue'}{!checking && <ArrowRight size={16} aria-hidden />}
        </Button>
      </div>
    </Card>
  )
}
