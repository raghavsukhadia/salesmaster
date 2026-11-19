// Scan Card reads a visiting card from two photos: the front, then the back.
// Kept apart from the React code so the "when is the card ready to read" rule can be tested on its own.

/** Photos needed before the card is read. */
export const CARD_PHOTOS = 2

const SIDES = ['front of the card', 'back of the card']

/** What to photograph next, given how many photos are already taken: "Photo 2 of 2: back of the card". */
export function nextPhotoPrompt(taken: number): string {
  const n = Math.min(Math.max(taken, 0), CARD_PHOTOS - 1)
  return `Photo ${n + 1} of ${CARD_PHOTOS}: ${SIDES[n]}`
}

/** Adds a photo. `ready` is true once the card has all its photos and can be read. If somehow over-full, the newest photos win. */
export function addShot(shots: readonly Blob[] | undefined, photo: Blob): { shots: Blob[]; ready: boolean } {
  const next = [...(shots ?? []), photo].slice(-CARD_PHOTOS)
  return { shots: next, ready: next.length === CARD_PHOTOS }
}

/** Drops one photo so it can be retaken. */
export const removeShot = (shots: readonly Blob[] | undefined, index: number): Blob[] => (shots ?? []).filter((_, i) => i !== index)
