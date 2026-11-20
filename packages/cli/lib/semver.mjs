const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/
const COMPARATOR_RE = /^(>=|<=|>|<|=|\^|~)?(\S+)$/

export function parseVersion(value) {
  if (typeof value !== 'string') return null
  const match = VERSION_RE.exec(value.trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

function compareIdentifiers(left, right) {
  const leftNumeric = /^\d+$/.test(left)
  const rightNumeric = /^\d+$/.test(right)
  if (leftNumeric && rightNumeric) return Math.sign(Number(left) - Number(right))
  if (leftNumeric) return -1
  if (rightNumeric) return 1
  if (left === right) return 0
  return left < right ? -1 : 1
}

export function compareVersions(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0
  if (left.prerelease.length === 0) return 1
  if (right.prerelease.length === 0) return -1
  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    if (left.prerelease[index] === undefined) return -1
    if (right.prerelease[index] === undefined) return 1
    const compared = compareIdentifiers(left.prerelease[index], right.prerelease[index])
    if (compared !== 0) return compared
  }
  return 0
}

function caretUpper(target) {
  if (target.major > 0) {
    return { major: target.major + 1, minor: 0, patch: 0, prerelease: [] }
  }
  if (target.minor > 0) {
    return { major: 0, minor: target.minor + 1, patch: 0, prerelease: [] }
  }
  return { major: 0, minor: 0, patch: target.patch + 1, prerelease: [] }
}

function tildeUpper(target) {
  return {
    major: target.major,
    minor: target.minor + 1,
    patch: 0,
    prerelease: [],
  }
}

function parseComparator(token) {
  if (token === '*' || token.toLowerCase() === 'x') {
    return { op: '*', version: null, raw: token }
  }
  const match = COMPARATOR_RE.exec(token)
  if (!match) return null
  const version = parseVersion(match[2])
  if (!version) return null
  return { op: match[1] || '=', version, raw: token }
}

export function parseRange(range) {
  if (typeof range !== 'string' || range.trim() === '') {
    return { valid: false, alternatives: [] }
  }
  const alternatives = []
  for (const part of range.split('||')) {
    const text = part.trim()
    if (text === '') return { valid: false, alternatives: [] }
    const comparators = []
    for (const token of text.split(/\s+/)) {
      const comparator = parseComparator(token)
      if (!comparator) return { valid: false, alternatives: [] }
      comparators.push(comparator)
    }
    alternatives.push({ raw: text, comparators })
  }
  return { valid: alternatives.length > 0, alternatives }
}

function matchesComparator(version, comparator) {
  const { op, version: target } = comparator
  if (op === '*') return true
  if (op === '=') return compareVersions(version, target) === 0
  if (op === '>') return compareVersions(version, target) > 0
  if (op === '>=') return compareVersions(version, target) >= 0
  if (op === '<') return compareVersions(version, target) < 0
  if (op === '<=') return compareVersions(version, target) <= 0
  if (op === '^') {
    return (
      compareVersions(version, target) >= 0 &&
      compareVersions(version, caretUpper(target)) < 0
    )
  }
  if (op === '~') {
    return (
      compareVersions(version, target) >= 0 &&
      compareVersions(version, tildeUpper(target)) < 0
    )
  }
  return false
}

export function satisfies(versionInput, range) {
  const version = parseVersion(versionInput)
  if (!version) return false
  const parsed = parseRange(range)
  if (!parsed.valid) return false
  return parsed.alternatives.some(alternative =>
    alternative.comparators.every(comparator => matchesComparator(version, comparator)),
  )
}

export function inspectUpperBound(range) {
  const parsed = parseRange(range)
  if (!parsed.valid) return { valid: false, bounded: false, bounds: [] }
  const bounds = []
  for (const alternative of parsed.alternatives) {
    const explicit = alternative.comparators.find(
      comparator => comparator.op === '<' || comparator.op === '<=',
    )
    const implicit = alternative.comparators.find(
      comparator => comparator.op === '^' || comparator.op === '~' || comparator.op === '=',
    )
    if (explicit) bounds.push(explicit.raw)
    else if (implicit) bounds.push(`${implicit.raw} (implicit)`)
    else return { valid: true, bounded: false, bounds }
  }
  return { valid: true, bounded: bounds.length === parsed.alternatives.length, bounds }
}
