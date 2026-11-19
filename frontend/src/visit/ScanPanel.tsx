import { useEffect, useRef, useState } from 'react'
import { Camera, CircleAlert, ImageUp, LoaderCircle, RefreshCw, ScanText, X } from 'lucide-react'
import { Button } from '../components/ui'
import CameraCapture, { cameraAvailable, type CameraFailure } from './CameraCapture'
import { canRead, nextPhotoPrompt } from './scanShots.ts'
import type { ScanState } from './types.ts'

const MAX_BYTES = 15 * 1024 * 1024

const WHY: Record<CameraFailure, string> = {
  unsupported: 'This browser cannot open the camera here (it needs a secure https connection).',
  denied: 'Camera permission was blocked. Allow camera access for this site in your browser settings, or use Upload Image.',
  notfound: 'No camera was found on this device. Use Upload Image instead.',
  error: 'The camera could not be started. Try again, or use Upload Image.',
}

/** Preview addresses for the photos in state. Made here rather than stored, so they are never stale after leaving and returning to this step. */
function usePreviews(shots: Blob[] | undefined): string[] {
  const [urls, setUrls] = useState<string[]>([])
  useEffect(() => {
    const made = (shots ?? []).map((b) => URL.createObjectURL(b))
    setUrls(made)
    return () => made.forEach((u) => URL.revokeObjectURL(u))
  }, [shots])
  return urls
}

function Thumbs({ urls, label, size, onRemove }: { urls: string[]; label: string; size: string; onRemove?: (i: number) => void }) {
  return (
    <ul className="flex gap-3" aria-label={label}>
      {urls.map((u, i) => (
        <li key={u} className="relative">
          <img src={u} alt={`Card photo ${i + 1}`} className={`${size} rounded-lg border bg-white object-contain`} />
          {onRemove && (
            <button type="button" onClick={() => onRemove(i)} aria-label={`Remove card photo ${i + 1} and retake it`}
              className="absolute -right-2 -top-2 grid size-6 place-items-center rounded-full bg-slate-800 text-white shadow hover:bg-slate-700"><X size={14} aria-hidden /></button>
          )}
        </li>
      ))}
    </ul>
  )
}

/** The Scan Card tab: the front of the card (required) and optionally the back, from the camera or a file, and the progress of reading them. Reviewing the result is the parent's form. */
export default function ScanPanel({ scan, onFile, onRead, onRemoveShot, onCameraOpen, onCameraClosed, onCameraFailed, onReset }: {
  scan: ScanState
  /** A photo to add, from the camera or from the file picker. */
  onFile: (photo: Blob) => void
  /** Read the card with the photos taken so far (the front alone is enough). */
  onRead: () => void
  /** Drop one of the photos taken so far, to retake it. */
  onRemoveShot: (index: number) => void
  onCameraOpen: () => void
  onCameraClosed: () => void
  onCameraFailed: (message: string, cameraProblem: boolean) => void
  onReset: () => void
}) {
  const upload = useRef<HTMLInputElement>(null)
  const native = useRef<HTMLInputElement>(null) // the phone's own camera app: the fallback when a live preview is not possible
  const previews = usePreviews(scan.shots)
  const taken = scan.shots?.length ?? 0
  const prompt = nextPhotoPrompt(taken)

  function picked(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    e.target.value = '' // let the same file be picked again after a retry
    if (!f) return
    if (!f.type.startsWith('image/')) return onCameraFailed('That file is not an image. Choose a JPEG or PNG photo of the card.', false)
    if (f.size > MAX_BYTES) return onCameraFailed('That photo is too large (over 15 MB). Take a new one or choose a smaller image.', false)
    onFile(f)
  }

  function takePhoto() {
    if (cameraAvailable()) onCameraOpen()
    else native.current?.click()
  }

  const busy = scan.phase === 'reading'
  const stage = scan.progress?.stage ?? 'preparing'
  const stageText = stage === 'reading' ? (taken > 1 ? `Reading photo ${scan.readingPhoto ?? 1} of ${taken}…` : 'Reading the card…')
    : stage === 'loading' ? 'Loading the card reader (first time only)…' : 'Preparing the photos…'

  return (
    <div className="space-y-4">
      <input ref={upload} type="file" accept="image/*" onChange={picked} className="sr-only" tabIndex={-1} aria-label="Upload a photo of the card" data-testid="card-upload" />
      <input ref={native} type="file" accept="image/*" capture="environment" onChange={picked} className="sr-only" tabIndex={-1} aria-label="Take a photo with the phone camera" data-testid="card-native-camera" />

      {scan.phase === 'camera' && (
        <>
          <p className="text-sm font-semibold text-slate-900" aria-live="polite">{prompt}</p>
          <CameraCapture
            onCapture={(blob) => onFile(blob)}
            onCancel={onCameraClosed}
            onFail={(why) => onCameraFailed(WHY[why], true)}
          />
        </>
      )}

      {(scan.phase === 'idle' || scan.phase === 'error') && (
        <>
          <p className="text-sm font-semibold text-slate-900" aria-live="polite">{prompt}</p>
          {taken > 0 && <Thumbs urls={previews} label="Card photos taken" size="h-24 w-36" onRemove={onRemoveShot} />}
          {canRead(taken) && (
            <div className="flex flex-col gap-2 rounded-xl border border-primary/30 bg-primary-soft p-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-slate-600">The front is enough. Add the back only if it has more details (address, more numbers).</p>
              <Button onClick={onRead} className="shrink-0"><ScanText size={16} aria-hidden />Read card now</Button>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <button type="button" onClick={takePhoto}
              className="group flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-slate-300 bg-white px-4 py-8 text-center transition-colors hover:border-primary hover:bg-primary-soft focus-visible:border-primary">
              <span className="grid size-12 place-items-center rounded-full bg-primary-soft text-primary group-hover:bg-white"><Camera size={24} aria-hidden /></span>
              <span>
                <span className="block font-semibold text-slate-900">Take Photo</span>
                <span className="mt-0.5 block text-xs text-slate-500">Use the camera to capture the card</span>
              </span>
            </button>
            <button type="button" onClick={() => upload.current?.click()}
              className="group flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-slate-300 bg-white px-4 py-8 text-center transition-colors hover:border-primary hover:bg-primary-soft focus-visible:border-primary">
              <span className="grid size-12 place-items-center rounded-full bg-primary-soft text-primary group-hover:bg-white"><ImageUp size={24} aria-hidden /></span>
              <span>
                <span className="block font-semibold text-slate-900">Upload Image</span>
                <span className="mt-0.5 block text-xs text-slate-500">Choose a photo of the card from this device</span>
              </span>
            </button>
          </div>
        </>
      )}

      {scan.phase === 'error' && scan.message && (
        <p role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <CircleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
          <span>
            {scan.message}
            {scan.cameraProblem && (
              <button type="button" onClick={() => native.current?.click()} className="ml-1 font-medium underline">Use the phone camera app</button>
            )}
          </span>
        </p>
      )}

      {busy && (
        <div role="status" aria-live="polite" className="overflow-hidden rounded-xl border bg-white">
          <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center">
            {previews.length > 0 && <Thumbs urls={previews} label="Card photos being read" size="h-28 w-32 sm:h-32 sm:w-40" />}
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 font-medium text-slate-900"><LoaderCircle size={18} className="animate-spin text-primary" aria-hidden />{stageText}</p>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100" aria-hidden>
                <div className={`h-full rounded-full bg-primary transition-[width] duration-300 ${stage === 'reading' ? '' : 'animate-pulse'}`}
                  style={{ width: stage === 'reading' ? `${Math.max(5, Math.round((scan.progress?.progress ?? 0) * 100))}%` : '15%' }} />
              </div>
              <p className="mt-2 text-xs text-slate-500">This takes a few seconds. You can still enter the details by hand using the other tabs.</p>
            </div>
          </div>
        </div>
      )}

      {scan.phase === 'done' && (
        <div className="flex flex-col gap-3 rounded-xl border bg-slate-50 p-3 sm:flex-row sm:items-center">
          {previews.length > 0 && <Thumbs urls={previews} label="Scanned card photos" size="h-20 w-28 sm:h-24 sm:w-32" />}
          <div className="min-w-0 flex-1 text-sm">
            <p className="font-medium text-slate-900">Card scanned ({taken} {taken === 1 ? 'photo' : 'photos'})</p>
            <p className="text-xs text-slate-500">Check the details below against the card and correct anything that was misread.</p>
          </div>
          <Button variant="secondary" size="sm" onClick={onReset}><RefreshCw size={14} aria-hidden />Scan again</Button>
        </div>
      )}
    </div>
  )
}
