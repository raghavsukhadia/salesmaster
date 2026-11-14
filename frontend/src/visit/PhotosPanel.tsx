import { useRef } from 'react'
import { Camera, CircleAlert, ImagePlus, LoaderCircle, RotateCw, X } from 'lucide-react'
import { Badge, Button, Card } from '../components/ui'
import { photoCounter, photoSummary } from './photoMath.ts'
import { photoStoreFor } from './photoStore.ts'
import { usePhotoState } from './photoState.ts'

/**
 * Car photos for the visit. Each photo uploads as soon as it is chosen, so "Save visit" only has to send ids,
 * and the server is the one that insists on the minimum. This panel just makes the requirement easy to meet.
 */
export default function PhotosPanel({ requestId }: { requestId: string }) {
  const { items, rules, min, checking } = usePhotoState(requestId)
  const store = photoStoreFor(requestId)
  const camera = useRef<HTMLInputElement>(null)
  const gallery = useRef<HTMLInputElement>(null)

  const need = min ?? 0
  const max = rules?.max_photos ?? 12
  const s = photoSummary(items, need)
  const room = max - items.length
  const met = need > 0 && s.done >= need

  function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    e.target.value = '' // lets the same photo be chosen again after removing it
    if (files.length) store.add(files, room)
  }

  return (
    <Card className="p-4 sm:p-6" aria-labelledby="car-photos-h">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="car-photos-h" className="text-lg font-semibold text-slate-900">Car photos{need > 0 && <span className="text-red-600" aria-hidden> *</span>}</h2>
        {!checking && <Badge tone={met ? 'green' : need > 0 ? 'amber' : 'gray'}>{photoCounter(items, need)}</Badge>}
      </div>
      <p className="mt-0.5 text-sm text-slate-500">
        {checking ? 'Checking how many photos this visit needs… ' : need > 0 ? `Add at least ${need} photos of the car. ` : 'Add photos of the car if you have them. '}
        They are saved with this visit and visible to your managers.
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="secondary" disabled={room <= 0} onClick={() => camera.current?.click()}><Camera size={16} aria-hidden />Take photo</Button>
        <Button variant="secondary" disabled={room <= 0} onClick={() => gallery.current?.click()}><ImagePlus size={16} aria-hidden />Upload from gallery</Button>
        {/* capture="environment" opens the rear camera directly on phones; desktops fall back to a file picker */}
        <input ref={camera} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} aria-label="Take a car photo" data-testid="photo-camera" onChange={pick} />
        <input ref={gallery} type="file" accept="image/*" multiple className="sr-only" tabIndex={-1} aria-label="Upload car photos from gallery" data-testid="photo-gallery" onChange={pick} />
      </div>

      {items.length > 0 && (
        <ul className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-4" aria-label="Car photos added">
          {items.map((p, n) => (
            <li key={p.key} className="relative aspect-square overflow-hidden rounded-lg border bg-slate-100">
              <img src={p.previewUrl} alt={`Car photo ${n + 1}`} className={`size-full object-cover ${p.status === 'done' ? '' : 'opacity-50'}`} />
              {p.status === 'uploading' && (
                <span role="status" className="absolute inset-0 grid place-items-center text-primary"><LoaderCircle className="animate-spin" size={22} aria-label="Uploading" /></span>
              )}
              {p.status === 'error' && (
                <div role="alert" className="absolute inset-x-0 bottom-0 bg-red-600/95 p-1.5 text-[11px] leading-tight text-white">
                  <p className="line-clamp-2">{p.error}</p>
                  <button type="button" onClick={() => store.retry(p.key)} className="mt-1 inline-flex items-center gap-1 font-semibold underline"><RotateCw size={11} aria-hidden />Retry</button>
                </div>
              )}
              <button type="button" aria-label={`Remove car photo ${n + 1}`} onClick={() => store.remove(p.key)}
                className="absolute right-1 top-1 grid size-7 place-items-center rounded-full bg-slate-900/70 text-white hover:bg-slate-900"><X size={14} aria-hidden /></button>
            </li>
          ))}
        </ul>
      )}

      {!checking && need > 0 && !met && (
        <p className="mt-3 flex items-center gap-1.5 text-sm text-amber-800" role="status">
          <CircleAlert size={15} aria-hidden />{s.missing === 1 ? '1 more photo needed' : `${s.missing} more photos needed`} before you can save the visit.
        </p>
      )}
      {room <= 0 && <p className="mt-3 text-xs text-slate-500">That is the maximum of {max} photos for one visit.</p>}
    </Card>
  )
}
