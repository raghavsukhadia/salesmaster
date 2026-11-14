// Temporary passwords for new salesmen and resets. Generated in the browser with the secure random source, shown once to
// the administrator to pass on, and sent to the server like any typed password (which still enforces its own rules).

/** No 0/O, 1/l/I or other look-alikes, so the password survives being read out over the phone or typed from a screenshot. */
export const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'

/** Three groups of four, e.g. "Xk7m-Qp9w-Rt4n": 12 random characters, about 70 bits, and easy to read aloud. */
export function generatePassword(random: (n: number) => Uint32Array = (n) => crypto.getRandomValues(new Uint32Array(n))): string {
  const size = PASSWORD_ALPHABET.length
  // Reject values from the uneven tail of the 32-bit range, so every character is exactly equally likely.
  const limit = Math.floor(0x1_0000_0000 / size) * size
  const chars: string[] = []
  while (chars.length < 12) {
    for (const v of random(24)) {
      if (v < limit && chars.length < 12) chars.push(PASSWORD_ALPHABET[v % size])
    }
  }
  return `${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars.slice(8).join('')}`
}
