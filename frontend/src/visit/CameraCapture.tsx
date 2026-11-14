import { useEffect, useRef, useState } from 'react'
import { Camera, LoaderCircle, X } from 'lucide-react'
import { Button } from '../components/ui'

export type CameraFailure = 'unsupported' | 'denied' | 'notfound' | 'error'

/** True when this page may ask for the camera: browsers only allow it on https or localhost. */
export const cameraAvailable = () => !!navigator.mediaDevices?.getUserMedia && window.isSecureContext

/**
 * Live viewfinder. Captures one full-resolution JPEG frame and hands it back. The camera is always released
 * on capture, cancel and unmount: leaving it running keeps the phone's camera light on and drains the battery.
 */
export default function CameraCapture({ onCapture, onCancel, onFail }: {
  onCapture: (photo: Blob) => void
  onCancel: () => void
  onFail: (why: CameraFailure) => void
}) {
  const video = useRef<HTMLVideoElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  // Callbacks come from the parent's render; keep the latest without restarting the camera when they change.
  const fail = useRef(onFail)
  useEffect(() => { fail.current = onFail })

  useEffect(() => {
    let live = true
    if (!cameraAvailable()) { fail.current('unsupported'); return }
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })
      .then((s) => {
        if (!live) { s.getTracks().forEach((t) => t.stop()); return } // closed while the permission prompt was open
        stream.current = s
        if (video.current) video.current.srcObject = s
      })
      .catch((e: unknown) => {
        if (!live) return
        const name = e instanceof DOMException ? e.name : ''
        fail.current(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'notfound' : 'error')
      })
    return () => {
      live = false
      stream.current?.getTracks().forEach((t) => t.stop())
      stream.current = null
    }
  }, [])

  function snap() {
    const v = video.current
    if (!v || !v.videoWidth || busy) return
    setBusy(true)
    const canvas = document.createElement('canvas')
    canvas.width = v.videoWidth
    canvas.height = v.videoHeight
    canvas.getContext('2d')?.drawImage(v, 0, 0)
    canvas.toBlob((blob) => {
      stream.current?.getTracks().forEach((t) => t.stop())
      stream.current = null
      if (blob) onCapture(blob)
      else { setBusy(false); fail.current('error') }
    }, 'image/jpeg', 0.92)
  }

  return (
    <div className="overflow-hidden rounded-xl border bg-slate-900">
      <div className="relative aspect-[4/3] w-full sm:aspect-video">
        <video ref={video} playsInline muted autoPlay aria-label="Camera preview" onLoadedMetadata={() => setReady(true)} className="size-full object-cover" />
        {ready && (
          // A card-shaped frame to line the card up in. Purely a guide: the whole frame is captured.
          <div aria-hidden className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="aspect-[1.75/1] w-[78%] max-w-md rounded-lg border-2 border-dashed border-white/80 shadow-[0_0_0_9999px_rgb(0_0_0/0.35)]" />
          </div>
        )}
        {!ready && <div role="status" className="absolute inset-0 grid place-items-center text-white/80"><span className="flex items-center gap-2 text-sm"><LoaderCircle className="animate-spin" size={18} aria-hidden />Starting camera…</span></div>}
      </div>
      <div className="flex items-center justify-between gap-3 bg-white p-3">
        <p className="text-xs text-slate-500">Fit the card inside the frame and hold steady.</p>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onCancel}><X size={16} aria-hidden />Cancel</Button>
          <Button onClick={snap} disabled={!ready} loading={busy}><Camera size={16} aria-hidden />Capture</Button>
        </div>
      </div>
    </div>
  )
}
