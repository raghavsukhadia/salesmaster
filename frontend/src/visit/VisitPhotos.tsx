import { useEffect, useState } from 'react'
import { ImageOff, LoaderCircle } from 'lucide-react'
import { apiFile } from '../auth'
import { Modal } from '../components/ui'

export interface VisitPhoto { id: number; kind: string; url: string }

/** Photos are private: the image URL needs the sign-in token, so it is fetched as a blob rather than put in an <img src>. */
function AuthImage({ url, alt, className }: { url: string; alt: string; className?: string }) {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    let made: string | null = null
    apiFile(url)
      .then(({ blob }) => { if (live) { made = URL.createObjectURL(blob); setSrc(made) } })
      .catch(() => { if (live) setFailed(true) })
    return () => { live = false; if (made) URL.revokeObjectURL(made) }
  }, [url])
  if (failed) return <span role="img" aria-label={`${alt} could not be loaded`} className={`grid place-items-center bg-slate-100 text-slate-400 ${className ?? ''}`}><ImageOff size={20} aria-hidden /></span>
  if (!src) return <span role="status" aria-label="Loading photo" className={`grid place-items-center bg-slate-100 text-slate-400 ${className ?? ''}`}><LoaderCircle className="animate-spin" size={20} aria-hidden /></span>
  return <img src={src} alt={alt} className={className} />
}

/** The photos taken on a visit, as thumbnails that open full size. Renders nothing at all for a visit with none (older visits). */
export default function VisitPhotos({ photos, wrapClass = 'rounded-xl border bg-white p-4', headingClass = 'mb-3 font-semibold' }: { photos?: VisitPhoto[]; wrapClass?: string; headingClass?: string }) {
  const [open, setOpen] = useState<number | null>(null)
  if (!photos?.length) return null
  const current = open !== null ? photos[open] : null
  return (
    <section className={wrapClass} aria-labelledby="visit-photos-h">
      <h2 id="visit-photos-h" className={headingClass}>Car photos ({photos.length})</h2>
      <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
        {photos.map((p, n) => (
          <li key={p.id}>
            <button type="button" onClick={() => setOpen(n)} aria-label={`Open car photo ${n + 1} of ${photos.length}`} className="block aspect-square w-full overflow-hidden rounded-lg border bg-slate-100">
              <AuthImage url={p.url} alt={`Car photo ${n + 1}`} className="size-full object-cover" />
            </button>
          </li>
        ))}
      </ul>
      {current && (
        <Modal title={`Car photo ${open! + 1} of ${photos.length}`} onClose={() => setOpen(null)} width="max-w-3xl">
          <AuthImage url={current.url} alt={`Car photo ${open! + 1}`} className="mx-auto max-h-[70vh] w-auto max-w-full rounded-lg" />
          {photos.length > 1 && (
            <div className="mt-3 flex justify-between text-sm">
              <button type="button" disabled={open === 0} onClick={() => setOpen((open ?? 0) - 1)} className="rounded-lg border px-3 py-1.5 disabled:opacity-40">Previous</button>
              <button type="button" disabled={open === photos.length - 1} onClick={() => setOpen((open ?? 0) + 1)} className="rounded-lg border px-3 py-1.5 disabled:opacity-40">Next</button>
            </div>
          )}
        </Modal>
      )}
    </section>
  )
}
