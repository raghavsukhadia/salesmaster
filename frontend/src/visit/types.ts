import type { CardField } from './cardParser.ts'
import type { DealerDraft } from './dealerDraft.ts'
import type { OcrProgress } from './cardOcr.ts'

export interface DealerLite { id: number; name: string; city: string; phone?: string }

export type DealerMode = 'scan' | 'manual' | 'existing'

/** The dealer the salesman settled on in step 1. */
export type Chosen = { kind: 'existing'; dealer: DealerLite } | { kind: 'new'; draft: DealerDraft }

export interface ScanState {
  phase: 'idle' | 'camera' | 'reading' | 'done' | 'error'
  /** The card photos taken so far, front first. The front alone can be read; with the back too, reading starts by itself. Kept as blobs so previews survive leaving the step. */
  shots?: Blob[]
  /** Which photo (1-based) is being read right now. */
  readingPhoto?: number
  progress?: OcrProgress
  message?: string
  /** The message is about the camera itself, so offering the phone's own camera app as a way round it makes sense. */
  cameraProblem?: boolean
  /** The raw OCR text, kept so the salesman can look at what the engine saw. */
  text?: string
  /** Which fields came off the card (so the form can mark them for checking). */
  filled?: CardField[]
}

export interface DealerState {
  mode: DealerMode
  draft: DealerDraft
  selected: DealerLite | null
  scan: ScanState
}
