/** Path/glob/limit helpers for Backup; kept out of index.js for the size budget. */
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, resolve as resolvePath, sep } from 'node:path'

export const HASH = 'sha256'

const fail = (code, message) => Object.assign(new Error(message), { code })
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const normalize = path => (process.platform === 'win32' ? path.toLowerCase() : path)
const HOME = (() => { try { return realpathSync(homedir()) } catch { return homedir() } })()

function absolute(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw fail('E_INVALID_ARGUMENT', `${field} must be a non-empty string`)
  if (value.includes('\0')) throw fail('E_INVALID_ARGUMENT', `${field} must not contain NUL`)
  if (!isAbsolute(value)) throw fail('E_INVALID_ARGUMENT', `${field} must be absolute: ${JSON.stringify(value)}`)
  if (value.split(/[\\/]/).includes('..')) throw fail('E_INVALID_ARGUMENT', `${field} must not contain "..": ${JSON.stringify(value)}`)
  return resolvePath(value)
}
function limit(value, fallback, field, hard) {
  if (value === undefined || value === null) return fallback
  if (!Number.isSafeInteger(value) || value < 1) throw fail('E_INVALID_ARGUMENT', `${field} must be a positive integer`)
  if (value > hard) throw fail('E_LIMIT', `${field} exceeds the hard cap (${hard})`)
  return value
}
function hashOption(value) {
  if (value === undefined || value === null || value === false) return null
  if (value !== HASH) throw fail('E_INVALID_ARGUMENT', 'hash must be "sha256" or omitted')
  return HASH
}
function idOf(value) {
  if (typeof value !== 'string' || value.trim() === '') throw fail('E_INVALID_ARGUMENT', 'id must be a non-empty string')
  return value
}
/** The filesystem root and the home directory are never valid roots or targets. */
const isForbidden = path => normalize(path) === normalize(parse(path).root) || normalize(path) === normalize(HOME)
const inside = (child, parent) => {
  const target = normalize(child)
  const base = normalize(parent)
  return target === base || target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
}
function canonical(path, field) {
  try { return realpathSync(path) } catch (error) {
    throw fail('E_UNAVAILABLE', `cannot resolve ${field} ${path}: ${error.message}`)
  }
}
/** Canonicalize an existing path, or the nearest existing ancestor of a future one. */
function canonicalLoose(path, field) {
  let current = path
  const tail = []
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) throw fail('E_INVALID_ARGUMENT', `cannot resolve ${field}: ${path}`)
    tail.unshift(basename(current))
    current = parent
  }
  return join(canonical(current, field), ...tail)
}

/** Relative glob patterns only: absolute patterns and `..` are rejected. */
function patternList(value, field) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw fail('E_INVALID_ARGUMENT', `${field} must be an array`)
  return value.map(item => {
    if (typeof item !== 'string' || item.trim() === '' || item.includes('\0')) {
      throw fail('E_INVALID_ARGUMENT', `${field} must contain non-empty strings`)
    }
    const pattern = item.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
    if (pattern === '' || /^(\/|[A-Za-z]:)/.test(pattern) || pattern.split('/').includes('..')) {
      throw fail('E_INVALID_ARGUMENT', `${field} must stay inside root: ${JSON.stringify(item)}`)
    }
    return pattern
  })
}
function globToRegExp(pattern) {
  let source = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '*') {
      if (pattern[index + 1] !== '*') source += '[^/]*'
      else {
        index += 1
        if (pattern[index + 1] === '/') { index += 1; source += '(?:.*/)?' } else source += '.*'
      }
    } else if (char === '?') source += '[^/]'
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}
/** A literal pattern also matches everything underneath it. */
function matcher(pattern) {
  if (!/[*?]/.test(pattern)) return rel => rel === pattern || rel.startsWith(`${pattern}/`)
  const regexp = globToRegExp(pattern)
  return rel => regexp.test(rel)
}
const anyMatch = (matchers, rel) => matchers.some(matches => matches(rel))

export {
  absolute, limit, hashOption, idOf, isForbidden, inside, canonical,
  canonicalLoose, patternList, globToRegExp, matcher, anyMatch,
  fail, plainObject, normalize, HOME,
}
