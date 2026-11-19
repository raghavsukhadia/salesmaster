// The new-dealer form: what a draft looks like, how to check it before it is sent, and how to build the request.
// The server re-checks everything (NewDealerSerializer); these checks exist so the salesman hears about a typo at the field.
import type { CardField } from './cardParser.ts'

export interface DealerDraft {
  name: string
  phone: string
  city: string
  state: string
  pincode: string
  address: string
  /** "Detect current location": the GPS fix taken at the shop, as strings. Empty until detected. Sent as the dealer's (unverified) location. */
  latitude: string
  longitude: string
  location_accuracy_m: string
}

export const EMPTY_DRAFT: DealerDraft = { name: '', phone: '', city: '', state: '', pincode: '', address: '', latitude: '', longitude: '', location_accuracy_m: '' }

/**
 * The form fields a scanned card can fill. The card's contact person, WhatsApp and GST number are not part of the
 * Record Visit form, so they are read and thrown away rather than filled into fields nobody can see.
 */
export const CARD_DRAFT_KEYS = ['name', 'phone', 'address', 'city', 'state', 'pincode'] as const satisfies readonly (keyof DealerDraft & CardField)[]

/** The location fields of a draft, kept together so a rescan or a clear moves them as one. */
export const LOCATION_KEYS = ['latitude', 'longitude', 'location_accuracy_m'] as const
export const hasLocation = (d: Pick<DealerDraft, 'latitude' | 'longitude'>) => !!(d.latitude && d.longitude)

/** Same rule as the server (apps/dealers/phone.py): digits only, last 10, so "+91 98765-43210" and "09876543210" are the same number. */
export const normalizePhone = (v: string) => v.replace(/\D/g, '').slice(-10)

/** True if the text, once stripped of spaces, dashes and a +91 / 0 prefix, is exactly 10 digits. */
export function isTenDigitNumber(v: string): boolean {
  let d = v.replace(/\D/g, '')
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2)
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1)
  return d.length === 10
}

/** Field name -> message. An empty object means the draft is good to send. The `_` key is a message about the form as a whole. */
export function validateDraft(d: DealerDraft): Record<string, string> {
  const e: Record<string, string> = {}
  // Every field on the form is required: business name, phone, address, city, state and pincode.
  if (!d.name.trim()) e.name = 'Enter the business name'
  if (!d.phone.trim()) e.phone = 'Enter the dealer’s 10-digit mobile number'
  else if (!isTenDigitNumber(d.phone)) e.phone = 'Enter a 10-digit mobile number'
  if (!d.address.trim()) e.address = 'Enter the shop address'
  if (!d.city.trim()) e.city = 'Enter the city'
  if (!d.state.trim()) e.state = 'Select the state'
  if (!d.pincode.trim()) e.pincode = 'Enter the 6-digit pincode'
  else if (!/^\d{6}$/.test(d.pincode.trim())) e.pincode = 'Enter a 6-digit pincode'
  // The shop's GPS location is required: a new dealer cannot be saved without it.
  if (!hasLocation(d)) e.location = 'Tap “Detect current location” while you are at the shop'
  return e
}

/** The `new_dealer` object for POST /api/visits/record/ and /api/dealers/check-duplicate/. Empty fields are left out. */
export function draftPayload(d: DealerDraft): Record<string, string> {
  const clean: Record<string, string> = {
    name: d.name.trim(),
    phone: d.phone.trim() ? normalizePhone(d.phone) : '',
    city: d.city.trim(),
    state: d.state.trim(),
    pincode: d.pincode.trim(),
    address: d.address.trim(),
    // Only ever sent as a pair: half a coordinate would be rejected by the server.
    ...(hasLocation(d) && { latitude: d.latitude, longitude: d.longitude, location_accuracy_m: d.location_accuracy_m }),
  }
  return Object.fromEntries(Object.entries(clean).filter(([, v]) => v !== ''))
}
