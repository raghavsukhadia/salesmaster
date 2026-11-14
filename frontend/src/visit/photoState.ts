import { useEffect, useState } from 'react'
import { api } from '../auth'
import { photoIds, photoProblem, type PhotoItem, type PhotoRules } from './photoMath.ts'
import { usePhotoItems } from './photoStore.ts'

// The rules are the same for everyone and change only when the server is reconfigured, so fetch them once per page
// load. Otherwise every return to the Order Details step (Back, then Continue) would flash "Checking…" again.
let cachedRules: PhotoRules | null = null

function useRules() {
  const [rules, setRules] = useState<PhotoRules | null>(cachedRules)
  const [loading, setLoading] = useState(cachedRules === null)
  useEffect(() => {
    if (cachedRules) return
    let live = true
    api<PhotoRules>('/api/visits/photo-rules/')
      .then((r) => { cachedRules = r; if (live) setRules(r) })
      .catch(() => { /* offline: the server will judge at save time */ })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [])
  return { rules, loading }
}

/** Everything the Order Details step needs to know about the car photos: what to send, and whether Save is allowed. */
export function usePhotoState(requestId: string) {
  const items: PhotoItem[] = usePhotoItems(requestId)
  const { rules, loading } = useRules()
  const checking = loading && !rules
  // Unknown while loading: Save waits a moment rather than racing past the rule. If the rules cannot be loaded at
  // all (offline), the server is the judge and its message is shown.
  const min = rules ? rules.min_car_photos : null
  const problem = checking ? 'Checking the photo requirements. Try again in a moment.' : photoProblem(items, min)
  return { items, rules, min, checking, ids: photoIds(items), problem }
}
