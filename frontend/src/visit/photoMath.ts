// Pure helpers for the car-photo requirement on Record Visit. No React, no browser APIs: unit-tested in photos.test.ts.

export interface PhotoRules {
  min_car_photos: number
  max_photos: number
  max_upload_mb: number
  kinds: { value: string; label: string }[]
}

export type PhotoStatus = 'uploading' | 'done' | 'error'

export interface PhotoItem {
  key: string
  /** Server id once the upload has finished. */
  id?: number
  previewUrl: string
  name: string
  status: PhotoStatus
  error?: string
}

/** Longest side capped at `max`, aspect ratio kept, never enlarged. */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (!(longest > max)) return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) }
  const scale = max / longest
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

export interface PhotoSummary { done: number; uploading: number; failed: number; missing: number; ready: boolean }

/** `min` is how many finished photos the visit needs. `ready` means: enough finished, nothing in flight, nothing broken. */
export function photoSummary(items: PhotoItem[], min: number): PhotoSummary {
  const done = items.filter((i) => i.status === 'done').length
  const uploading = items.filter((i) => i.status === 'uploading').length
  const failed = items.filter((i) => i.status === 'error').length
  const missing = Math.max(0, min - done)
  return { done, uploading, failed, missing, ready: missing === 0 && uploading === 0 && failed === 0 }
}

export const photoIds = (items: PhotoItem[]): number[] =>
  items.filter((i) => i.status === 'done' && typeof i.id === 'number').map((i) => i.id as number)

/** The message to show when Save is pressed too early, or null if the photos are fine. `min` null = rules unknown: the server decides. */
export function photoProblem(items: PhotoItem[], min: number | null): string | null {
  if (min === null) return null
  const s = photoSummary(items, min)
  if (s.uploading) return 'Wait for the photos to finish uploading.'
  if (s.failed) return 'Retry or remove the photo that failed to upload.'
  if (s.missing) return `Add at least ${min} car photos (you have ${s.done}).`
  return null
}

/** "1 of 2 required" / "2 added" / "Optional". */
export function photoCounter(items: PhotoItem[], min: number): string {
  const { done } = photoSummary(items, min)
  if (min <= 0) return done ? `${done} added` : 'Optional'
  return done >= min ? `${done} added` : `${done} of ${min} required`
}
