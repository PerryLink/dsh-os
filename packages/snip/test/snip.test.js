import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SnipService, apply, detectSecret } from '../index.js'

const T0 = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000

test('add, list, search and handle lookup', () => {
  const snip = new SnipService({ now: () => T0 })
  const first = snip.add({ text: 'hello world', sourceApp: 'Chrome' })
  assert.deepEqual(Object.keys(first).sort(), [
    'createdAt', 'expiresAt', 'handle', 'id', 'kind', 'preview', 'redacted',
  ])
  assert.equal(first.kind, 'text')
  assert.equal(first.preview, 'hello world')
  assert.equal(first.redacted, false)
  assert.equal(first.handle, `clipboard://${first.id}`)
  assert.equal(Date.parse(first.expiresAt) - Date.parse(first.createdAt), DAY)

  const second = snip.add({ text: 'second note', kind: 'link' })
  assert.deepEqual(snip.list().map(entry => entry.id), [second.id, first.id])
  assert.deepEqual(snip.list({ kind: 'link' }).map(entry => entry.id), [second.id])
  assert.deepEqual(snip.list({ kind: 'color' }), [])
  assert.deepEqual(snip.search('HELLO').map(entry => entry.id), [first.id])
  assert.deepEqual(snip.search('note', { limit: 1 }).map(entry => entry.id), [second.id])
  assert.equal(snip.get(first.id).text, 'hello world')
  assert.equal(snip.get(first.handle).sourceApp, 'Chrome')
  assert.equal(snip.get('missing'), null)
  assert.throws(() => snip.search('   '), { code: 'SNIP_BAD_QUERY' })
  assert.throws(() => snip.add({ text: '   ' }), { code: 'SNIP_EMPTY_TEXT' })
})

test('redacts secrets by default and never stores the original', () => {
  const cases = [
    ['openai-key', `key sk-${'a'.repeat(32)}`, 'sk-'],
    ['openai-key', 'short sk-abc123', 'sk-abc123'],
    ['github-token', `token ghp_${'b'.repeat(36)}`, 'ghp_'],
    ['aws-access-key', `AKIA${'C'.repeat(16)}`, 'AKIA'],
    ['private-key', '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----', 'BEGIN OPENSSH'],
    ['password', 'password=hunter2', 'hunter2'],
    ['api-key', 'api_key = "abcdefgh12345678"', 'abcdefgh12345678'],
  ]
  for (const [reason, text, leak] of cases) {
    assert.equal(detectSecret(text), reason)
    const snip = new SnipService()
    const added = snip.add({ text })
    assert.equal(added.redacted, true)
    assert.equal(added.preview, `[redacted:${reason}]`)
    const entry = snip.get(added.id)
    assert.equal(entry.text, `[redacted:${reason}]`)
    assert.ok(!JSON.stringify(entry).includes(leak))
    assert.ok(!JSON.stringify(snip.list()).includes(leak))
  }

  const forced = new SnipService().add({ text: 'ordinary text', sensitivity: 'secret' })
  assert.equal(forced.preview, '[redacted:sensitivity]')

  const unsafe = new SnipService({ excludeSecrets: false })
  const stored = unsafe.add({ text: `key sk-${'a'.repeat(32)}` })
  assert.equal(stored.redacted, false)
  assert.match(unsafe.get(stored.id).text, /^key sk-/)
})

test('ttl expiry, maxEntries eviction and maxBytes rejection', () => {
  let clock = T0
  const snip = new SnipService({ ttlMs: 1_000, maxEntries: 2, now: () => clock })
  const first = snip.add({ text: 'first' })
  clock += 10
  const second = snip.add({ text: 'second' })
  clock += 10
  const third = snip.add({ text: 'third' })

  assert.equal(snip.list().length, 2)
  assert.equal(snip.get(first.id), null, 'oldest entry is evicted at maxEntries')
  assert.deepEqual(snip.list().map(entry => entry.id), [third.id, second.id])

  clock += 2_000
  assert.equal(snip.get(second.id), null, 'expired entries are cleaned on access')
  assert.deepEqual(snip.list(), [])

  const tiny = new SnipService({ maxBytes: 5 })
  assert.equal(tiny.add({ text: '12345' }).preview, '12345')
  assert.throws(() => tiny.add({ text: '123456' }), { code: 'SNIP_TOO_LARGE' })
})

test('forget and clear remove entries by id or handle', () => {
  const snip = new SnipService()
  const first = snip.add({ text: 'first' })
  const second = snip.add({ text: 'second' })

  assert.equal(snip.forget(first.handle), true)
  assert.equal(snip.forget(first.id), false)
  assert.equal(snip.get(first.id), null)
  assert.equal(snip.clear(), 1)
  assert.deepEqual(snip.list(), [])
  assert.equal(snip.get(second.id), null)
  assert.equal(snip.clear(), 0)
})

test('stateFile persists redacted data atomically and reloads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-snip-'))
  try {
    const stateFile = join(dir, 'state.json')
    const secret = `sk-${'z'.repeat(32)}`
    const snip = new SnipService({ stateFile })
    const redacted = snip.add({ text: `secret ${secret}` })
    const normal = snip.add({ text: 'persisted note', kind: 'link', sourceApp: 'editor' })

    const raw = readFileSync(stateFile, 'utf8')
    assert.ok(!raw.includes(secret))
    assert.ok(raw.includes('persisted note'))
    assert.deepEqual(readdirSync(dir), ['state.json'])

    const loaded = new SnipService({ stateFile })
    assert.equal(loaded.get(normal.id).text, 'persisted note')
    assert.equal(loaded.get(redacted.id).text, '[redacted:openai-key]')

    loaded.forget(normal.handle)
    const reloaded = new SnipService({ stateFile })
    assert.equal(reloaded.get(normal.id), null)
    assert.equal(reloaded.list().length, 1)

    const unsafeFile = join(dir, 'unsafe.json')
    const unsafe = new SnipService({ stateFile: unsafeFile, excludeSecrets: false })
    const unsafeEntry = unsafe.add({ text: `leak sk-${'y'.repeat(32)}` })
    assert.ok(readFileSync(unsafeFile, 'utf8').includes('leak sk-'))
    const safe = new SnipService({ stateFile: unsafeFile })
    assert.equal(safe.get(unsafeEntry.id).text, '[redacted:openai-key]')
    assert.ok(!readFileSync(unsafeFile, 'utf8').includes('leak sk-'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sourceApp is screened for secrets and length/character validated', () => {
  const snip = new SnipService()
  const labelled = snip.add({ text: 'note', sourceApp: '  Chrome  ' })
  assert.equal(snip.get(labelled.id).sourceApp, 'Chrome')
  assert.equal(snip.get(snip.add({ text: 'no app' }).id).sourceApp, 'unknown')

  for (const label of [
    `key sk-${'a'.repeat(32)}`,
    `ghp_${'b'.repeat(36)}`,
    `AKIA${'C'.repeat(16)}`,
    'Slack\nInjected',
    'x'.repeat(81),
    42,
  ]) {
    assert.throws(() => snip.add({ text: 'rejected', sourceApp: label }), { code: 'SNIP_BAD_SOURCE_APP' })
  }
  assert.equal(snip.list().length, 2, 'rejected sourceApp values are never stored')
})

test('loading a snapshot strips secret-looking sourceApp metadata', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-snip-meta-'))
  try {
    const stateFile = join(dir, 'state.json')
    const secretApp = `Chrome sk-${'d'.repeat(32)}`
    writeFileSync(stateFile, JSON.stringify({
      version: 1,
      entries: [{
        id: 'legacy',
        kind: 'text',
        text: 'legacy text',
        sourceApp: secretApp,
        createdAt: new Date(T0).toISOString(),
        expiresAt: new Date(T0 + DAY).toISOString(),
      }],
    }), 'utf8')

    const snip = new SnipService({ stateFile, now: () => T0 })
    assert.equal(snip.get('legacy').sourceApp, 'unknown')
    assert.ok(!readFileSync(stateFile, 'utf8').includes(secretApp))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('search only sees stored text and forget leaves no index residue', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-snip-search-'))
  try {
    const stateFile = join(dir, 'state.json')
    const snip = new SnipService({ stateFile })
    const secret = `sk-${'s'.repeat(32)}`
    const added = snip.add({ text: `my ${secret}`, sourceApp: 'shell' })

    assert.deepEqual(snip.search(secret), [])
    assert.deepEqual(snip.search('my'), [])
    assert.deepEqual(snip.search('[redacted:openai-key]').map(entry => entry.id), [added.id])
    assert.equal(snip.forget(added.id), true)
    assert.deepEqual(snip.search('[redacted:openai-key]'), [])
    assert.ok(!readFileSync(stateFile, 'utf8').includes(secret))

    const reloaded = new SnipService({ stateFile })
    assert.deepEqual(reloaded.list(), [])
    assert.deepEqual(reloaded.search(secret), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('failed state writes leave memory and disk unchanged', t => {
  if (process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)) {
    return t.skip('needs POSIX write permissions owned by a non-root user')
  }
  const dir = mkdtempSync(join(tmpdir(), 'dsh-snip-ro-'))
  try {
    const stateFile = join(dir, 'state.json')
    const snip = new SnipService({ stateFile })
    const kept = snip.add({ text: 'kept' })
    chmodSync(dir, 0o500)
    try {
      assert.throws(() => snip.add({ text: 'blocked' }), { code: 'SNIP_STATE_WRITE_FAILED' })
      assert.equal(snip.list().length, 1)
      assert.equal(snip.get(kept.id).text, 'kept')
      assert.throws(() => snip.forget(kept.id), { code: 'SNIP_STATE_WRITE_FAILED' })
      assert.equal(snip.get(kept.id).text, 'kept')
    } finally {
      chmodSync(dir, 0o700)
    }

    const reloaded = new SnipService({ stateFile })
    assert.equal(reloaded.list().length, 1)
    assert.equal(reloaded.get(kept.id).text, 'kept')
  } finally {
    try { chmodSync(dir, 0o700) } catch {}
    rmSync(dir, { recursive: true, force: true })
  }
})

function fakeContext() {
  const tools = new Map()
  const services = new Map()
  return {
    tools: { register: tool => (tools.set(tool.name, tool), () => tools.delete(tool.name)) },
    provide: (serviceName, value) => services.set(serviceName, value),
    get: serviceName => services.get(serviceName),
    _tools: tools,
    _services: services,
  }
}

test('apply provides ctx.snip and registers six plain-object tools', async () => {
  const ctx = fakeContext()
  const service = apply(ctx, { now: () => T0 })
  assert.equal(ctx.get('snip'), service)
  assert.deepEqual([...ctx._tools.keys()].sort(), [
    'snip_add', 'snip_clear', 'snip_forget', 'snip_get', 'snip_list', 'snip_search',
  ])
  for (const definition of ctx._tools.values()) {
    assert.equal(typeof definition.description, 'string')
    assert.equal(definition.parameters.type, 'object')
    assert.equal(typeof definition.output.render, 'function')
  }

  const added = await ctx._tools.get('snip_add').execute({ text: 'tool note', sourceApp: 'test' })
  assert.equal(added.handle, `clipboard://${added.id}`)
  const got = await ctx._tools.get('snip_get').execute({ id: added.handle })
  assert.equal(got.text, 'tool note')
  const searched = await ctx._tools.get('snip_search').execute({ query: 'tool' })
  assert.equal(searched.entries.length, 1)
  const listed = await ctx._tools.get('snip_list').execute({ kind: 'text' })
  assert.equal(listed.entries.length, 1)
  await ctx._tools.get('snip_forget').execute({ id: added.id })
  assert.deepEqual(await ctx._tools.get('snip_list').execute({}), { entries: [] })
  await assert.rejects(ctx._tools.get('snip_get').execute({ id: 'missing' }), { code: 'SNIP_NOT_FOUND' })

  const captured = await ctx._tools.get('snip_add').execute({ text: `ghp_${'q'.repeat(36)}` })
  assert.equal(captured.redacted, true)
  assert.equal((await ctx._tools.get('snip_clear').execute({})).removed, 1)
})
