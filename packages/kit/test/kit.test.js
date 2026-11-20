import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const PATCH_URL = new URL('../cordis.patch.yml', import.meta.url)
const PACKAGE_URL = new URL('../package.json', import.meta.url)

const EXPECTED = [
  { id: 'dsh-act', name: 'dsh-act' },
  { id: 'dsh-allow', name: 'dsh-allow' },
  { id: 'dsh-snip', name: 'dsh-snip' },
  { id: '@perrylink/dsh-check', name: '@perrylink/dsh-check' },
]

function unquote(value) {
  const trimmed = value.trim()
  const quoted = (trimmed.startsWith("'") && trimmed.endsWith("'"))
    || (trimmed.startsWith('"') && trimmed.endsWith('"'))
  return quoted ? trimmed.slice(1, -1) : trimmed
}

/** Minimal parser for the flat `- insert: [{ id, name }]` rows the kit uses. */
function parseInsertRows(text) {
  const rows = []
  let current = null
  for (const line of text.split(/\r?\n/)) {
    const id = line.match(/^\s*-\s+id:\s*(.+?)\s*$/)
    if (id) {
      current = { id: unquote(id[1]) }
      rows.push(current)
      continue
    }
    const name = line.match(/^\s+name:\s*(.+?)\s*$/)
    if (name && current !== null) current.name = unquote(name[1])
  }
  return rows
}

test('cordis.patch.yml inserts exactly the four core modules', () => {
  const patch = readFileSync(PATCH_URL, 'utf8')
  assert.deepEqual(parseInsertRows(patch), EXPECTED)
  assert.equal((patch.match(/^\s*-\s+id:/gm) ?? []).length, 4)
})

test('patch rows carry no config payload', () => {
  const patch = readFileSync(PATCH_URL, 'utf8')
  assert.doesNotMatch(patch, /^\s+config:/m)
})

test('manifest stays dependency-only and points at the patch', () => {
  const manifest = JSON.parse(readFileSync(PACKAGE_URL, 'utf8'))

  assert.equal(manifest.name, 'dsh-os-kit')
  assert.equal(manifest.version, '0.1.0')
  assert.deepEqual(
    Object.keys(manifest.dependencies).sort(),
    EXPECTED.map(row => row.name).sort(),
  )
  for (const range of Object.values(manifest.dependencies)) assert.equal(range, '^0.1.0')

  assert.deepEqual(manifest.dsh.bundle, { patch: './cordis.patch.yml' })
  assert.deepEqual(manifest.dsh.os, {
    service: null,
    provides: [],
    capabilities: [],
    tools: [],
    stability: 'experimental',
    since: '0.1.0',
  })
})

test('index.js is an empty plugin entry', async () => {
  const plugin = await import('../index.js')
  assert.equal(plugin.name, 'dsh-os-kit')
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(plugin.apply(), undefined)
})
