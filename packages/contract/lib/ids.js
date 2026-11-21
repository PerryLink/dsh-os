/**
 * Process-local ULID-style ids (`req_…`, `aud_…`). Zero dependencies beyond
 * Node's crypto; no I/O and no persistence.
 * @module @perrylink/dsh-os-contract/lib/ids
 */
import { randomBytes } from 'node:crypto'

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** Crockford base32 ULID (26 characters) with an optional prefix. */
export function newId(prefix = '') {
  let time = Date.now()
  let encoded = ''
  for (let index = 0; index < 10; index += 1) {
    encoded = CROCKFORD[time % 32] + encoded
    time = Math.floor(time / 32)
  }
  for (const byte of randomBytes(16)) encoded += CROCKFORD[byte & 31]
  return `${prefix}${encoded}`
}
