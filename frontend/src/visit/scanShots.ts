// Scan Card reads a visiting card from one or two photos: the front (required), then optionally the back.
// Kept apart from the React code so the "when is the card ready to read" rule can be tested on its own.

/** Most photos a card can have (front and back). Taking the last one starts reading straight away. */
export const CARD_PHOTOS = 2
/** Photos needed before the card can be read: the front alone is enough. */
export const MIN_CARD_PHOTOS = 1

/** What to photograph next, given how many photos are already taken. */
export function nextPhotoPrompt(taken: number): string {
  return taken <= 0 ? 'Photo 1: front of the card' : 'Photo 2 (optional): back of the card'
}

/** The card has enough photos to be read now (the back can still be added). */
export const canRead = (taken: number) => taken >= MIN_CARD_PHOTOS

/** Adds a photo. `full` is true once both sides are in, so reading can start without asking. If somehow over-full, the newest photos win. */
export function addShot(shots: readonly Blob[] | undefined, photo: Blob): { shots: Blob[]; full: boolean } {
  const next = [...(shots ?? []), photo].slice(-CARD_PHOTOS)
  return { shots: next, full: next.length === CARD_PHOTOS }
}

/** Drops one photo so it can be retaken. */
export const removeShot = (shots: readonly Blob[] | undefined, index: number): Blob[] => (shots ?? []).filter((_, i) => i !== index)
