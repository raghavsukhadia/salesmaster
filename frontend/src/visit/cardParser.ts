// Turns the raw text OCR reads off a visiting card into dealer fields.
//
// OCR output is noisy, so every rule here is a best guess: the Record Visit screen always shows the result in an
// editable form and the salesman confirms it. Rules prefer leaving a field empty over filling it with a wrong value.
// No regex lookbehind anywhere: iOS Safari before 16.4 refuses to parse a bundle that contains one.
import { INDIAN_STATES } from '../states.ts'

export interface CardFields {
  name: string
  contact_name: string
  phone: string
  whatsapp: string
  address: string
  city: string
  state: string
  pincode: string
  gst_number: string
}
export type CardField = keyof CardFields

export const EMPTY_CARD: CardFields = { name: '', contact_name: '', phone: '', whatsapp: '', address: '', city: '', state: '', pincode: '', gst_number: '' }

/** Same shape the server enforces (NewDealerSerializer.gst_number). */
export const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/

/** First two digits of a GSTIN are the state code. Used only when the card never names the state. */
const GST_STATE: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana',
  '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland',
  '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand',
  '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat', '25': 'Dadra and Nagar Haveli and Daman and Diu',
  '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep',
  '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman and Nicobar Islands', '36': 'Telangana',
  '37': 'Andhra Pradesh', '38': 'Ladakh',
}

/** Spellings cards use that differ from the canonical list in states.ts. */
const STATE_ALIASES: [string, string][] = [
  ['orissa', 'Odisha'], ['pondicherry', 'Puducherry'], ['uttaranchal', 'Uttarakhand'], ['nct of delhi', 'Delhi'],
  ['jammu & kashmir', 'Jammu and Kashmir'], ['j&k', 'Jammu and Kashmir'], ['andaman & nicobar islands', 'Andaman and Nicobar Islands'],
  ['maharastra', 'Maharashtra'], ['chattisgarh', 'Chhattisgarh'],
]

// ───────────────────────── small helpers ─────────────────────────

const clean = (l: string) =>
  l.replace(/[–—]/g, '-').replace(/[|•·*►▶■□●◆_~=]+/g, ' ').replace(/\s+/g, ' ').trim()

const trimEdges = (s: string) => s.replace(/^[^A-Za-z0-9(]+/, '').replace(/[^A-Za-z0-9).]+$/, '').trim()

const titleCase = (s: string) => (s === s.toUpperCase() ? s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : s)

const letters = (s: string) => (s.match(/[A-Za-z]/g) ?? []).length

/** Mostly real text, not a logo smudge like "=-- ,|" or "Ee a". */
const looksLikeText = (s: string) => {
  const compact = s.replace(/\s/g, '')
  return letters(s) >= 3 && letters(s) / compact.length >= 0.6
}

const DIGIT_FIX: Record<string, string> = { O: '0', Q: '0', D: '0', I: '1', L: '1', Z: '2', S: '5', B: '8', G: '6' }
const LETTER_FIX: Record<string, string> = { '0': 'O', '1': 'I', '2': 'Z', '5': 'S', '8': 'B', '6': 'G' }
const GST_DIGIT_POS = new Set([0, 1, 7, 8, 9, 10])
const GST_LETTER_POS = new Set([2, 3, 4, 5, 6, 11])

const GST_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** The 15th character of a GSTIN is a check character over the first 14 (mod-36, alternating weights 1 and 2). */
export function gstinCheckChar(first14: string): string {
  let sum = 0
  ;[...first14].forEach((c, i) => {
    const product = GST_CHARS.indexOf(c) * (i % 2 === 0 ? 1 : 2)
    sum += Math.floor(product / 36) + (product % 36)
  })
  return GST_CHARS[(36 - (sum % 36)) % 36]
}
export const gstinChecksumOk = (g: string) => g.length === 15 && gstinCheckChar(g.slice(0, 14)) === g[14]

/** Undo the usual O/0, I/1, S/5, B/8, Z/2/7 confusions by position, since each position is a digit, a letter or a "Z". */
function fixPositions(t: string): string {
  const fixed = [...t].map((c, i) => {
    if (GST_DIGIT_POS.has(i)) return /\d/.test(c) ? c : DIGIT_FIX[c] ?? c
    if (GST_LETTER_POS.has(i)) return /[A-Z]/.test(c) ? c : LETTER_FIX[c] ?? c
    if (i === 13) return c === '2' || c === '7' ? 'Z' : c
    return c
  }).join('')
  return GSTIN_RE.test(fixed) ? fixed : ''
}

/**
 * A GSTIN read off a card, or '' if it cannot be trusted. A token that already has the right shape is taken as printed.
 * A damaged one is only repaired when the repair also passes the GSTIN check character, and (for one stray extra
 * character) only when exactly one way of removing it does. A wrong GSTIN is worse than none: it is how dealers are matched.
 */
export function repairGstin(token: string): string {
  const t = token.toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (t.length === 15) {
    if (GSTIN_RE.test(t)) return t
    const fixed = fixPositions(t)
    return fixed && gstinChecksumOk(fixed) ? fixed : ''
  }
  if (t.length === 16) {
    const found = new Set<string>()
    for (let i = 0; i < t.length; i++) {
      const cand = t.slice(0, i) + t.slice(i + 1)
      const fixed = GSTIN_RE.test(cand) ? cand : fixPositions(cand)
      if (fixed && gstinChecksumOk(fixed)) found.add(fixed)
    }
    return found.size === 1 ? [...found][0] : ''
  }
  return ''
}

function findGstin(line: string): string {
  const compact = line.toUpperCase().replace(/[^A-Z0-9]/g, '')
  const label = /^.*?GST(?:IN|NO|N)?/.exec(compact)
  if (label) {
    const start = label[0].length
    const v = repairGstin(compact.slice(start, start + 15)) || repairGstin(compact.slice(start, start + 16))
    if (v) return v
  }
  const m = /\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]/.exec(compact)
  return m && GSTIN_RE.test(m[0]) ? m[0] : ''
}

/**
 * Indian mobile numbers only (10 digits starting 6-9), optionally with +91 / 91 / 0 in front, in any grouping
 * (98765 43210, 987 654 3210, 98-7654-3210) with single spaces, dots or dashes between digits.
 * After a leading 0 only the plain shapes count (09876543210, 0 98765 43210), so landlines such as 0712-6781234 or
 * 020 2456 7890 do not match. Group 2 (or 3, after a 0) is the national number.
 */
const MOBILE_SRC = String.raw`(^|[^\d])(?:(?:(?:\+|00)?91[\s.-]*)?([6-9](?:[\s.-]?\d){9})|\(?0\)?[\s.-]*([6-9]\d{9}|[6-9]\d{4}[\s.-]\d{5}))(?!\d)`

/** OCR reads 0 as O/o and 1 as l/I inside long digit runs ("98765 432l0"). Fixes them only inside such runs, so words are untouched. */
const fixDigitRuns = (line: string) =>
  line.replace(/\d[\dOoIl\s.-]{8,}[\dOo]/g, (run) => (/\d.*\d.*\d.*\d.*\d.*\d/.test(run) ? run.replace(/[Oo]/g, '0').replace(/[Il]/g, '1') : run))
const MOBILE = new RegExp(MOBILE_SRC, 'g')
/** Same number, plus the "Mob:" / "Ph." style label sitting right in front of it, so masking leaves no stray label behind. */
const MOBILE_WITH_LABEL = new RegExp(String.raw`(?:\b(?:mob(?:ile)?|ph(?:one)?|tel|cell|call|whats\s?app|w\/?a)\b\.?(?:\s*no\.?)?[\s:.-]*)?` + MOBILE_SRC, 'gi')

const mobilesIn = (line: string) => [...line.matchAll(MOBILE)].map((m) => (m[2] ?? m[3]).replace(/\D/g, ''))
const maskMobiles = (line: string) => line.replace(MOBILE_WITH_LABEL, '$1 ')

const BUSINESS_WORD = /\b(enterprises?|traders?|trading|auto|autos|automobiles?|motors?|tyres?|tires?|accessor(?:y|ies)|agenc(?:y|ies)|stores?|pvt|private|ltd|limited|llp|company|co|corporation|corp|industries|solutions|services|sales|mart|point|centre|center|garage|hub|world|zone|house|distributors?|wholesale|retail|films?|tint|tints|car|cars|care|decor|shop|emporium|associates|works|workshop|group|brothers|bros|sons|exports?|imports?|marketing|systems|technologies|tech|mobiles?|electronics?|electricals?|hardware|glass|garments?|studio|detailing|customs?|wraps?|ppf)\b/i

const DESIGNATION = /\b(proprietor|proprietress|prop|owner|managing director|director|partner|manager|founder|co-?founder|ceo|md|chairman|executive)\b\.?/i

const TITLE = /^(mr|mrs|ms|miss|dr|shri|shree|sri|smt|er|ca|adv)\.?\s+/i

const TAGLINE = /^(dealers?|deals?|we deal|all kinds|specialists?|manufacturers?|suppliers?|importers?|exporters?|wholesalers?|retailers?|since|est\.?|established)\b/i

/** "Mob:", "Tel -", "Add." ... a label needs its separator, otherwise "Mobile World Accessories" would count as a label. */
const LABEL_LINE = /^(mob(?:ile)?|ph(?:one)?|tel|telephone|cell|call|e-?mail|mail|web(?:site)?|www|add(?:ress)?|gst(?:in)?|pan|fax|off(?:ice)?|res|timings?|time|visit|follow)\s*(?:no\.?)?\s*[:.-]/i
const ADDRESS_LABEL = /^(?:add(?:ress)?|regd\.?\s*office|off(?:ice)?)\s*[:.-]\s*/i

const ADDRESS_WORD = /\b(road|rd|street|st|nagar|colony|market|chowk|chauk|plaza|complex|building|bldg|floor|shop|plot|sector|lane|near|nr|opp|opposite|behind|beside|industrial|estate|marg|gali|galli|bazaar|bazar|highway|phase|ward|village|post|po|dist|district|taluka|tal|tq|cross|layout|towers?|apartments?|society|mall|circle|square|bus stand|station|gate|area|extension|cantt|cantonment|stand|nh|gala|bhavan|bhawan|bhuvan|peth|wadi|mohalla|chawl|arcade|block|unit|flat|midc|gidc|vihar|enclave|sadan|niwas|nivas|kunj|puram|main)\b\.?/i

/** "12, ..." / "12/3, ..." / "12-A, ..." at the start of a line. A bare "24 Hours Service" is not an address. */
const LEADING_NUMBER = /^\d+(?:[/-]\w+)*\s*,/

const hasEmailOrWeb = (l: string) => /@|\bwww\.|https?:|\.(?:com|in|net|org|co\.in)\b/i.test(l)

// ───────────────────────── state / city ─────────────────────────

const STATE_NAMES: [string, string][] = [
  ...INDIAN_STATES.map((s): [string, string] => [s.toLowerCase(), s]),
  ...STATE_ALIASES,
].sort((a, b) => b[0].length - a[0].length)

/** The state named in `text` (longest name first, whole words only), or ''. */
function stateIn(text: string): string {
  const t = text.toLowerCase().replace(/\s+/g, ' ')
  for (const [needle, canonical] of STATE_NAMES) {
    const i = t.indexOf(needle)
    if (i < 0) continue
    const before = t[i - 1]
    const after = t[i + needle.length]
    if ((!before || !/[a-z]/.test(before)) && (!after || !/[a-z]/.test(after))) return canonical
  }
  return ''
}

/** The whole text is just a state name ("Karnataka", "Orissa."), so it is part of the address and not a shop name. */
const isStateOnly = (s: string) => {
  const st = stateIn(s)
  return st !== '' && letters(s) <= letters(st) + 1
}

/** Segments of an address, split on commas and on " - " (as in "Pune - 411001"). */
const segments = (addr: string) => addr.split(/\s*[,;]\s*|\s+-\s+|\s*-\s*(?=\d{6}\b)/).map(trimEdges).filter(Boolean)

/** Delhi and Chandigarh are single-city states: the city and the state are the same word. */
const CITY_STATES = new Set(['Delhi', 'Chandigarh'])

function cityFrom(addr: string, pincode: string, state: string): string {
  const segs = segments(addr)
  const isState = isStateOnly
  // A city is a place name: no digits, no "Road"/"Complex"/"Near", not the state, not the country.
  const usable = (s: string) => s !== '' && letters(s) >= 3 && !/\d/.test(s) && s.toLowerCase() !== 'india' && !isState(s) && !ADDRESS_WORD.test(s)
  const isDistrict = (s: string) => /^(?:dist(?:rict)?|tal(?:uka)?)\b/i.test(s)
  const tidy = (s: string) => trimEdges(s.replace(/^(?:dist(?:rict)?|tal(?:uka)?|city)\b\.?[:\s-]*/i, '').replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' '))
  const lookBack = (from: number) => {
    let district = ''
    for (let i = from; i >= 0; i--) {
      const c = tidy(segs[i])
      // "Karad, Dist. Satara": the town comes before the district, so keep the district only as a last resort.
      if (usable(c) && isDistrict(segs[i])) { district ||= titleCase(c); continue }
      if (usable(c)) return titleCase(c)
      if (isState(c) && CITY_STATES.has(state)) return state
    }
    return district
  }

  const pinRe = pincode ? new RegExp(`${pincode.slice(0, 3)}\\s?${pincode.slice(3)}`) : null // printed as 440012 or 440 012
  const pinAt = pinRe ? segs.findIndex((s) => pinRe.test(s)) : -1
  if (pinRe && pinAt >= 0) {
    // "Pune 411001" or "Uttar Pradesh 201301": drop the pincode and any "Pin:" label, then see what is left.
    const rest = tidy(segs[pinAt].replace(pinRe, ' ').replace(/\bpin\s*(?:code)?\b[:.\s-]*/i, ' '))
    if (usable(rest)) return titleCase(rest)
    return lookBack(pinAt - 1)
  }
  const stateAt = state ? segs.findIndex((s) => stateIn(s) === state) : -1
  return stateAt > 0 ? lookBack(stateAt - 1) : ''
}

// ───────────────────────── names ─────────────────────────

const LEAD_DESIGNATION = /^(proprietor|proprietress|prop|owner|managing director|director|partner|manager|founder|ceo|md|chairman)\b\.?[\s:-]+/i
const TRAIL_DESIGNATION = /[\s,(\-|]*\b(proprietor|proprietress|prop|owner|managing director|director|partner|manager|founder|ceo|md|chairman)\b\.?\)?\s*$/i

/** "Rajesh Sharma (Proprietor)" -> "Rajesh Sharma". */
function stripDesignation(line: string): { text: string; had: boolean } {
  const text = trimEdges(line.replace(LEAD_DESIGNATION, '').replace(TRAIL_DESIGNATION, ''))
  return { text, had: text !== trimEdges(line) }
}

/** A line that is nothing but a job title: "Proprietor", "(Owner)", "Director & Partner". */
const onlyDesignation = (line: string) => {
  const t = trimEdges(line.replace(/[()]/g, ' ')).replace(/\s+/g, ' ')
  return DESIGNATION.test(t) && t.replace(new RegExp(DESIGNATION.source, 'gi'), '').replace(/[\s&,/-]|\band\b/gi, '').length === 0
}

const isAllCaps = (s: string) => letters(s) > 0 && s === s.toUpperCase()

/** A lone logo glyph at the end of a line ("SHARMA AUTO O": the circle next to the name read as an O). */
const stripTrailingGlyph = (s: string) => {
  const words = s.split(' ')
  return words.length > 2 && /^[OQ0Il|©®]$/.test(words[words.length - 1]) ? words.slice(0, -1).join(' ') : s
}

function looksLikePerson(line: string): boolean {
  const base = line.replace(TITLE, '').trim()
  if (!base || /\d|[&@]/.test(base) || BUSINESS_WORD.test(base)) return false
  const words = base.split(' ')
  if (words.length < 2 || words.length > 4) return false
  return words.every((w) => /^[A-Z][A-Za-z.'-]*$/.test(w) && (w.length >= 2 || /^[A-Z]\.?$/.test(w)))
}

// ───────────────────────── main entry ─────────────────────────

export function parseCard(raw: string): CardFields {
  const out: CardFields = { ...EMPTY_CARD }
  const L = raw.split(/\r?\n/).map(clean).filter(Boolean)
  const consumed = new Set<number>() // lines that are data (phone, GSTIN, email...), never a name or an address

  // 1. GSTIN.
  L.forEach((line, i) => {
    const gst = findGstin(line)
    if (!gst) return
    out.gst_number ||= gst
    consumed.add(i)
  })

  // 2. Mobile numbers. Each is masked out of its line so it cannot later be read as a pincode or part of a name.
  let waNumber = ''
  L.forEach((original, i) => {
    if (/\bfax\b/i.test(original)) return
    const line = fixDigitRuns(original)
    const nums = mobilesIn(line)
    if (!nums.length) return
    const isWa = /whats\s?app|\bw\/?a\b/i.test(line)
    for (const n of nums) {
      if (isWa) waNumber ||= n
      else out.phone ||= n
    }
    L[i] = clean(maskMobiles(line))
    if (letters(L[i].replace(LABEL_LINE, '')) < 3) consumed.add(i)
  })
  out.whatsapp = waNumber && waNumber !== out.phone ? waNumber : ''

  // 3. Email, website and "GSTIN:" lines are data too.
  L.forEach((l, i) => { if (hasEmailOrWeb(l) || /^gst/i.test(l)) consumed.add(i) })

  // 4. Pincode: a "Pin: 411001" label wins; otherwise a six digit number, preferring lines that read like an address.
  let best = { pin: '', score: 0 }
  L.forEach((l, i) => {
    if (consumed.has(i) && findGstin(l)) return
    if (/\b(cin|reg(?:d)?\.?\s*no|licen[cs]e|fssai|udyam|pan)\b/i.test(l)) return
    const labelled = /\bpin\s*(?:code)?\s*[:.-]?\s*([1-9]\d{2})\s?(\d{3})(?!\d)/i.exec(l)
    if (labelled) { if (best.score < 3) best = { pin: labelled[1] + labelled[2], score: 3 }; return }
    const addressy = /[,-]/.test(l) || !!stateIn(l)
    for (const m of l.matchAll(/(^|[^\d])([1-9]\d{5})(?!\d)/g)) {
      const score = addressy ? 2 : 1
      if (score > best.score) best = { pin: m[2], score }
    }
    // "Nagpur - 440 012": a pincode printed in two groups, trusted only on a line that reads like an address.
    if (addressy && best.score < 2) {
      const spaced = /(^|[^\d])([1-9]\d{2}) (\d{3})(?![\d])/.exec(l)
      if (spaced) best = { pin: spaced[2] + spaced[3], score: 2 }
    }
  })
  out.pincode = best.pin

  // 5. Address lines.
  const pinPrinted = out.pincode ? new RegExp(`${out.pincode.slice(0, 3)}\\s?${out.pincode.slice(3)}`) : null
  const isAddr = L.map((l, i) => {
    if (consumed.has(i)) return false
    if (ADDRESS_LABEL.test(l) && letters(l.replace(ADDRESS_LABEL, '')) >= 3) return true // "Add: Gandhi Bhavan, ..." is an address whatever it says
    if (pinPrinted && pinPrinted.test(l)) return true
    if (/\bpin\s*(?:code)?\b/i.test(l)) return true
    if (isStateOnly(l) || (stateIn(l) && /[,\d-]/.test(l))) return true
    return ADDRESS_WORD.test(l) || LEADING_NUMBER.test(l)
  })
  // A short line between two address lines ("Ganesh Complex" between "Shop 3," and "MG Road,") belongs to them.
  for (let i = 1; i < L.length - 1; i++) {
    if (!isAddr[i] && isAddr[i - 1] && isAddr[i + 1] && !consumed.has(i) && L[i].split(' ').length <= 5 && looksLikeText(L[i])) isAddr[i] = true
  }
  // An address that wraps: a line ending in "," or "-" (or an "Add:" line) carries on to the next one ("Add: 14, Gandhi Bhavan," / "Sitabuldi,").
  for (let i = 1; i < L.length; i++) {
    const prev = L[i - 1]
    const carries = isAddr[i - 1] && (/[,-]$/.test(prev) || ADDRESS_LABEL.test(prev))
    if (!isAddr[i] && carries && !consumed.has(i) && !LABEL_LINE.test(L[i]) && !onlyDesignation(L[i]) && L[i].split(' ').length <= 8
        && (looksLikeText(L[i]) || /\d/.test(L[i]))) isAddr[i] = true
  }
  const addrText = L.filter((_, i) => isAddr[i]).map((l) => trimEdges(l.replace(ADDRESS_LABEL, ''))).filter(Boolean).join(', ')
  out.address = addrText

  // 6. State (from the address, else from the GSTIN's state code) and city.
  const named = stateIn(addrText)
  out.state = named || (out.gst_number ? GST_STATE[out.gst_number.slice(0, 2)] ?? '' : '')
  out.city = cityFrom(addrText, out.pincode, named)

  // 7. Names. The person is whoever sits next to a job title; the business is the first remaining line, preferring one that reads like a business.
  const candidates: number[] = []
  L.forEach((l, i) => {
    if (consumed.has(i) || isAddr[i] || LABEL_LINE.test(l) || TAGLINE.test(l) || !looksLikeText(l)) return
    candidates.push(i)
  })
  const real = candidates.filter((i) => !onlyDesignation(L[i]))

  let contactIdx = -1
  let contactText = ''
  const labelled = L.map((l) => /^(?:contact(?: person)?|name|owner|prop(?:rietor)?)\s*[:-]\s*(.{3,})$/i.exec(l)?.[1])
  const lab = labelled.findIndex((v) => v && looksLikeText(v))
  if (lab >= 0) { contactIdx = lab; contactText = trimEdges(labelled[lab]!) }

  if (contactIdx < 0) {
    for (const d of candidates.filter((i) => onlyDesignation(L[i]))) {
      const near = [d - 1, d + 1].find((j) => real.includes(j) && looksLikePerson(stripDesignation(L[j]).text))
      if (near !== undefined) { contactIdx = near; break }
    }
  }
  if (contactIdx < 0) contactIdx = real.find((i) => stripDesignation(L[i]).had && looksLikePerson(stripDesignation(L[i]).text)) ?? -1
  if (contactIdx < 0) contactIdx = real.find((i) => TITLE.test(L[i]) && looksLikePerson(L[i])) ?? -1
  // No title or designation at all: a plain person-like line after the first one (the first is nearly always the business).
  if (contactIdx < 0 && real.length > 1) contactIdx = real.slice(1).find((i) => looksLikePerson(L[i])) ?? -1

  const pool = real.filter((i) => i !== contactIdx)
  const businessIdx = pool.find((i) => BUSINESS_WORD.test(L[i])) ?? pool.find((i) => !looksLikePerson(L[i])) ?? -1
  if (businessIdx >= 0) {
    let name = trimEdges(stripTrailingGlyph(trimEdges(L[businessIdx])))
    // A name often wraps onto a second line ("SHARMA AUTO" / "ACCESSORIES"). Join the very next line when it is a short,
    // same-style continuation: not a person, not a job title, not the contact, and printed in the same case.
    const nextIdx = businessIdx + 1
    if (real.includes(nextIdx) && nextIdx !== contactIdx && !looksLikePerson(L[nextIdx]) && L[nextIdx].split(' ').length <= 4
        && isAllCaps(L[nextIdx]) === isAllCaps(name) && name.split(' ').length + L[nextIdx].split(' ').length <= 6) {
      name = `${name} ${trimEdges(stripTrailingGlyph(trimEdges(L[nextIdx])))}`
    }
    out.name = name
  }
  if (contactIdx >= 0) out.contact_name = titleCase(contactText || stripDesignation(L[contactIdx]).text.replace(TITLE, ''))

  return out
}
