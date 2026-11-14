// Holds the photos for one visit form. A store, not component state, so going Back to the Dealer step and
// returning to Order details keeps every photo (each is already uploaded to the server by then).
import { useSyncExternalStore } from 'react'
import { api, ApiError } from '../auth'
import { flatten } from '../components/ui'
import { fitWithin, type PhotoItem } from './photoMath.ts'

const MAX_SIDE = 1600 // enough to see a number plate; a phone's 12 MP original would waste the salesman's mobile data
const JPEG_QUALITY = 0.82
const KEEP_STORES = 3

/** Shrinks a camera photo before upload. Falls back to the original file if the browser cannot decode it. */
async function toUploadBlob(file: File): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' })
    const { width, height } = fitWithin(bmp.width, bmp.height, MAX_SIDE)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, width, height)
    bmp.close?.()
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', JPEG_QUALITY))
    if (blob) return blob
  } catch { /* fall through to the original */ }
  return file
}

function uploadError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 429) return 'Too many uploads at once. Wait a moment, then retry.'
    if (e.status === 413) return 'That photo is too large.'
    if (e.status === 400) return flatten(e.data)[0] ?? 'That photo could not be used.'
    if (e.status === 401 || e.status === 403) return 'You are signed out. Sign in again.'
    return 'The server could not save the photo. Retry.'
  }
  return 'No connection. Retry when you are back online.'
}

class PhotoStore {
  private items: PhotoItem[] = []
  private blobs = new Map<string, Blob>()
  private listeners = new Set<() => void>()
  private chain: Promise<void> = Promise.resolve() // one upload at a time: gentle on mobile networks and the rate limit

  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  getItems = () => this.items
  private set(next: PhotoItem[]) { this.items = next; this.listeners.forEach((l) => l()) }
  private patch(key: string, p: Partial<PhotoItem>) { this.set(this.items.map((i) => (i.key === key ? { ...i, ...p } : i))) }

  add(files: File[], room: number) {
    for (const file of files.slice(0, Math.max(0, room))) {
      const key = crypto.randomUUID()
      this.set([...this.items, { key, previewUrl: URL.createObjectURL(file), name: file.name, status: 'uploading' }])
      this.chain = this.chain.then(async () => {
        this.blobs.set(key, await toUploadBlob(file))
        await this.send(key)
      })
    }
  }

  retry(key: string) {
    if (!this.blobs.has(key)) return
    this.patch(key, { status: 'uploading', error: undefined })
    this.chain = this.chain.then(() => this.send(key))
  }

  private async send(key: string) {
    const blob = this.blobs.get(key)
    if (!blob || !this.items.some((i) => i.key === key)) return // removed while it was waiting its turn
    try {
      const fd = new FormData()
      fd.append('image', blob, 'car.jpg')
      fd.append('kind', 'car')
      const row = await api<{ id: number }>('/api/visits/photos/', { method: 'POST', body: fd })
      if (this.items.some((i) => i.key === key)) this.patch(key, { id: row.id, status: 'done' })
      else void api(`/api/visits/photos/${row.id}/`, { method: 'DELETE' }).catch(() => {}) // removed mid-upload
    } catch (e) {
      this.patch(key, { status: 'error', error: uploadError(e) })
    }
  }

  remove(key: string) {
    const item = this.items.find((i) => i.key === key)
    if (!item) return
    URL.revokeObjectURL(item.previewUrl)
    this.blobs.delete(key)
    this.set(this.items.filter((i) => i.key !== key))
    if (item.id !== undefined) void api(`/api/visits/photos/${item.id}/`, { method: 'DELETE' }).catch(() => {}) // best effort: stragglers are purged nightly
  }

  dispose() { this.items.forEach((i) => URL.revokeObjectURL(i.previewUrl)); this.blobs.clear(); this.listeners.clear() }
}

const stores = new Map<string, PhotoStore>()

/** One store per visit form (keyed by its request id). Older forms' stores are released as new ones are opened. */
export function photoStoreFor(key: string): PhotoStore {
  let s = stores.get(key)
  if (!s) {
    s = new PhotoStore()
    stores.set(key, s)
    while (stores.size > KEEP_STORES) {
      const oldest = stores.keys().next().value as string
      stores.get(oldest)?.dispose()
      stores.delete(oldest)
    }
  }
  return s
}

export function usePhotoItems(key: string): PhotoItem[] {
  const store = photoStoreFor(key)
  return useSyncExternalStore(store.subscribe, store.getItems)
}
