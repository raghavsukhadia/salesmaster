// The new-dealer form: what a draft looks like, how to check it before it is sent, and how to build the request.
// The server re-checks everything (NewDealerSerializer); these checks exist so the salesman hears about a typo at the field.
import { GSTIN_RE } from './cardParser.ts'

export interface DealerDraft {
  name: string
  contact_name: string
  phone: string
  whatsapp: string
  city: string
  state: string
  pincode: string
  gst_number: string
  address: string
  /** "Detect current location": the GPS fix taken at the shop, as strings. Empty until detected. Sent as the dealer's (unverified) location. */
  latitude: string
  longitude: string
  location_accuracy_m: string
}

export const EMPTY_DRAFT: DealerDraft = { name: '', contact_name: '', phone: '', whatsapp: '', city: '', state: '', pincode: '', gst_number: '', address: '', latitude: '', longitude: '', location_accuracy_m: '' }

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
  if (!d.name.trim()) e.name = 'Enter the dealer or shop name'
  if (d.phone.trim() && !isTenDigitNumber(d.phone)) e.phone = 'Enter a 10-digit mobile number'
  if (d.whatsapp.trim() && !isTenDigitNumber(d.whatsapp)) e.whatsapp = 'Enter a 10-digit mobile number'
  if (d.pincode.trim() && !/^\d{6}$/.test(d.pincode.trim())) e.pincode = 'Enter a 6-digit pincode'
  if (d.gst_number.trim() && !GSTIN_RE.test(d.gst_number.trim().toUpperCase())) e.gst_number = 'Enter a valid 15-character GSTIN'
  if (!(d.phone.trim() || d.whatsapp.trim() || d.gst_number.trim() || d.city.trim())) {
    e._ = 'Add a phone, WhatsApp, GST number or city so this dealer can be told apart from others.'
  }
  return e
}

/** The `new_dealer` object for POST /api/visits/record/ and /api/dealers/check-duplicate/. Empty fields are left out. */
export function draftPayload(d: DealerDraft): Record<string, string> {
  const clean: Record<string, string> = {
    name: d.name.trim(),
    contact_name: d.contact_name.trim(),
    phone: d.phone.trim() ? normalizePhone(d.phone) : '',
    whatsapp: d.whatsapp.trim() ? normalizePhone(d.whatsapp) : '',
    city: d.city.trim(),
    state: d.state.trim(),
    pincode: d.pincode.trim(),
    gst_number: d.gst_number.trim().toUpperCase(),
    address: d.address.trim(),
    // Only ever sent as a pair: half a coordinate would be rejected by the server.
    ...(hasLocation(d) && { latitude: d.latitude, longitude: d.longitude, location_accuracy_m: d.location_accuracy_m }),
  }
  return Object.fromEntries(Object.entries(clean).filter(([, v]) => v !== ''))
}
