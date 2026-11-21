import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { apply, ActService } from '../index.js'

/** Fake Cordis context from docs/implementation-contract.md. */
function fakeContext() {
  const tools = new Map()
  const services = new Map()
  return {
    tools: { register: tool => (tools.set(tool.name, tool), () => tools.delete(tool.name)) },
    provide: (name, value) => services.set(name, value),
    get: name => services.get(name),
    _tools: tools,
    _services: services,
  }
}

function setup(allow, config) {
  const ctx = fakeContext()
  if (allow !== undefined) ctx._services.set('allow', allow)
  const service = apply(ctx, config)
  return { ctx, service }
}

/** Fresh temp workdir, removed when the test finishes. */
function workdir(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-act-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const allowAll = { check: async () => ({ granted: true }) }

test('apply provides ctx.act and registers both tools', () => {
  const { ctx } = setup()
  assert.ok(ctx.get('act') instanceof ActService)
  assert.deepEqual([...ctx._tools.keys()], ['act_list', 'act_invoke'])
})

test('built-ins list, echo and now stay compatible', async () => {
  const { service } = setup()
  assert.deepEqual(service.list().map(action => action.id), [
    'echo', 'now', 'list', 'fs.read', 'fs.write', 'fs.list', 'fs.undo',
  ])
  assert.deepEqual(service.list('echo').map(action => action.id), ['echo'])
  assert.equal(service.list({ riskMax: 'read' }).length, 5)

  assert.deepEqual(await service.invoke('echo', { text: 'hello' }), {
    ok: true,
    actionId: 'echo',
    result: { text: 'hello' },
  })
  const now = await service.invoke('now')
  assert.equal(now.ok, true)
  assert.match(now.result.now, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  const listed = await service.invoke('list')
  assert.equal(listed.result.actions.length, 7)
  assert.equal(listed.result.actions[0].execute, undefined)
})

test('register validates id, risk and execute; duplicates throw', () => {
  const { service } = setup()
  assert.throws(() => service.register({ id: 'Echo', title: 'x', risk: 'read', execute() {} }), /invalid action id/)
  assert.throws(() => service.register({ id: 'a', title: 'x', risk: 'read', execute() {} }), /invalid action id/)
  assert.throws(() => service.register({ id: 'ok.id', title: 'x', risk: 'exec', execute() {} }), /risk/)
  assert.throws(() => service.register({ id: 'ok.id', title: 'x', risk: 'read' }), /execute/)
  assert.throws(
    () => service.register({ id: 'echo', title: 'Dup', risk: 'read', execute() {} }),
    /already registered/,
  )
})

test('write without an Allow service is denied without executing', async () => {
  const { service } = setup()
  let calls = 0
  service.register({
    id: 'write.action',
    title: 'Write',
    risk: 'write',
    execute() { calls += 1 },
  })
  assert.deepEqual(await service.invoke('write.action'), {
    ok: false,
    code: 'grant_required',
    actionId: 'write.action',
    capability: 'act:invoke:write.action',
  })
  assert.equal(calls, 0)
})

test('an authorized write runs and the grant request carries subject and scope', async () => {
  const checks = []
  const allow = {
    async check(request) {
      checks.push(request)
      return { granted: true }
    },
  }
  const { service } = setup(allow)
  service.register({
    id: 'danger.action',
    title: 'Danger',
    risk: 'danger',
    execute(args, meta) {
      return { args, subject: meta?.subject }
    },
  })
  const result = await service.invoke('danger.action', { n: 1 }, { subject: 'tester', scope: { path: '/tmp' } })
  assert.equal(result.ok, true)
  assert.deepEqual(result.result, { args: { n: 1 }, subject: 'tester' })
  assert.deepEqual(checks, [{ subject: 'tester', capability: 'act:invoke:danger.action' }])
})

test('denied and throwing checks fail closed; sessionId is the subject fallback', async () => {
  const seen = []
  const allow = {
    async check(request) {
      seen.push(request.subject)
      return { granted: false }
    },
  }
  const { service } = setup(allow)
  service.register({ id: 'write.one', title: 'One', risk: 'write', execute: () => 'ran' })
  assert.equal((await service.invoke('write.one', {}, { sessionId: 'session-1' })).code, 'grant_required')
  // Missing subject fails closed: no shared 'anonymous' identity is created.
  assert.equal((await service.invoke('write.one')).code, 'grant_required')
  assert.deepEqual(seen, ['session-1', 'session-1'])
  assert.equal((await service.invoke('echo', { text: 'read still runs' })).ok, true)

  const broken = setup({ check: async () => { throw new Error('ledger unavailable') } })
  broken.service.register({ id: 'write.two', title: 'Two', risk: 'write', execute: () => 'ran' })
  assert.equal((await broken.service.invoke('write.two')).code, 'grant_required')
})

test('execute failures and unknown ids return structured results', async () => {
  const { service } = setup()
  service.register({
    id: 'explode',
    title: 'Explode',
    risk: 'read',
    execute() { throw new Error('boom') },
  })
  assert.deepEqual(await service.invoke('explode'), {
    ok: false,
    code: 'action_failed',
    message: 'boom',
  })
  assert.deepEqual(await service.invoke('missing'), {
    ok: false,
    code: 'action_not_found',
    actionId: 'missing',
  })
})

test('unregister and get reflect the registry', () => {
  const { service } = setup()
  const dispose = service.register({ id: 'temp.action', title: 'Temp', risk: 'read', execute: () => 1 })
  assert.equal(service.get('temp.action').title, 'Temp')
  assert.equal(dispose(), true)
  assert.equal(service.get('temp.action'), undefined)
})

test('agent tools list and invoke through the service', async () => {
  const { ctx, service } = setup()
  const listed = await ctx._tools.get('act_list').execute({ query: 'echo' })
  assert.deepEqual(listed.actions.map(action => action.id), ['echo'])

  const invoked = await ctx._tools.get('act_invoke').execute({ id: 'echo', args: { text: 'via tool' } })
  assert.deepEqual(invoked, { ok: true, actionId: 'echo', result: { text: 'via tool' } })
  await assert.rejects(ctx._tools.get('act_invoke').execute({}), /non-empty string id/)

  service.register({ id: 'write.tool', title: 'Write', risk: 'write', execute: () => 'ran' })
  assert.deepEqual(await ctx._tools.get('act_invoke').execute({ id: 'write.tool' }), {
    ok: false,
    code: 'grant_required',
    actionId: 'write.tool',
    capability: 'act:invoke:write.tool',
  })
})

test('fs.read returns path, size and text, and enforces the configured cap', async t => {
  const root = workdir(t)
  const file = join(root, 'hello.txt')
  writeFileSync(file, 'abcdefgh')
  const { service } = setup(undefined, { workdir: root, maxReadBytes: 4 })

  assert.deepEqual(await service.invoke('fs.read', { path: file }), {
    ok: true,
    actionId: 'fs.read',
    result: { path: file, size: 8, text: 'abcd' },
  })
  // maxBytes can lower the cap but never raise it above the configured cap.
  assert.equal((await service.invoke('fs.read', { path: file, maxBytes: 2 })).result.text, 'ab')
  assert.equal((await service.invoke('fs.read', { path: file, maxBytes: 99 })).result.text, 'abcd')
  assert.equal((await service.invoke('fs.read', { path: file, unknown: true })).reason, 'E_INVALID_ARGUMENT')
})

test('fs.read defaults to a 256 KiB cap', async t => {
  const root = workdir(t)
  const file = join(root, 'big.txt')
  writeFileSync(file, 'x'.repeat(256 * 1024 + 16))
  const { service } = setup(undefined, { workdir: root })
  const result = await service.invoke('fs.read', { path: file })
  assert.equal(result.result.size, 256 * 1024 + 16)
  assert.equal(result.result.text.length, 256 * 1024)
})

test('fs.list lists directories, optionally recursively and with a limit', async t => {
  const root = workdir(t)
  mkdirSync(join(root, 'sub'))
  writeFileSync(join(root, 'a.txt'), 'a')
  writeFileSync(join(root, 'sub', 'b.txt'), 'bb')
  const { service } = setup(undefined, { workdir: root })

  const flat = await service.invoke('fs.list', { path: root })
  assert.equal(flat.ok, true)
  assert.deepEqual(flat.result.entries.map(entry => relative(root, entry.path)).sort(), ['a.txt', 'sub'])
  assert.deepEqual(flat.result.entries.find(entry => entry.path === join(root, 'a.txt')), {
    path: join(root, 'a.txt'), type: 'file', size: 1,
  })

  const deep = await service.invoke('fs.list', { path: root, recursive: true })
  assert.deepEqual(deep.result.entries.map(entry => relative(root, entry.path)).sort(), [
    'a.txt', 'sub', join('sub', 'b.txt'),
  ])
  assert.equal((await service.invoke('fs.list', { path: root, recursive: true, limit: 1 })).result.entries.length, 1)
  assert.equal((await service.invoke('fs.list', { path: join(root, 'a.txt') })).reason, 'E_NOT_DIR')
})

test('paths must be absolute, inside the workdir, and free of ".." or symlink escapes', async t => {
  const root = workdir(t)
  const outside = workdir(t)
  writeFileSync(join(outside, 'secret.txt'), 'secret')
  const { service } = setup(undefined, { workdir: root })

  assert.equal((await service.invoke('fs.read', { path: 'relative.txt' })).reason, 'E_PATH')
  assert.equal((await service.invoke('fs.read', { path: `${root}/../escape.txt` })).reason, 'E_PATH')
  assert.equal((await service.invoke('fs.read', { path: join(outside, 'secret.txt') })).reason, 'E_PATH_OUTSIDE')

  try {
    symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'))
    symlinkSync(outside, join(root, 'linked'), 'dir')
  } catch {
    t.skip('symlinks are not available on this platform')
    return
  }
  assert.equal((await service.invoke('fs.read', { path: join(root, 'link.txt') })).reason, 'E_PATH_OUTSIDE')
  assert.equal((await service.invoke('fs.read', { path: join(root, 'linked', 'secret.txt') })).reason, 'E_PATH_OUTSIDE')
})

test('fs.write rejects a granted write that escapes the workdir', async t => {
  const root = workdir(t)
  const outside = workdir(t)
  writeFileSync(join(outside, 'target.txt'), 'outside')
  const { service } = setup(allowAll, { workdir: root })

  const absolute = join(outside, 'escape.txt')
  assert.equal((await service.invoke('fs.write', { path: absolute, text: 'x' }, { subject: 'tester' })).reason, 'E_PATH_OUTSIDE')
  assert.equal(existsSync(absolute), false)
  assert.equal((await service.invoke('fs.write', { path: `${root}/../escape.txt`, text: 'x' }, { subject: 'tester' })).reason, 'E_PATH')

  try {
    symlinkSync(join(outside, 'target.txt'), join(root, 'link.txt'))
  } catch {
    t.skip('symlinks are not available on this platform')
    return
  }
  const linked = await service.invoke('fs.write', { path: join(root, 'link.txt'), text: 'hijacked' }, { subject: 'tester' })
  assert.equal(linked.reason, 'E_PATH_OUTSIDE')
  assert.equal(readFileSync(join(outside, 'target.txt'), 'utf8'), 'outside')
})

test('fs.write without a grant is denied, hints allow_request, and does not create the file', async t => {
  const root = workdir(t)
  const file = join(root, 'new.txt')
  const allow = {
    check: async () => ({ granted: false }),
    request: async request => request,
  }
  const { service } = setup(allow, { workdir: root })
  const result = await service.invoke('fs.write', { path: file, text: 'new' }, { subject: 'tester' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'grant_required')
  assert.equal(result.capability, 'act:invoke:fs.write')
  assert.match(result.hint, /Call allow_request/)
  assert.equal(existsSync(file), false)
})

test('fs.write previews a diff without touching disk', async t => {
  const root = workdir(t)
  const file = join(root, 'note.txt')
  writeFileSync(file, 'old\n')
  const { ctx, service } = setup(undefined, { workdir: root })

  const preview = await service.invoke('fs.write', { path: file, text: 'new\n' }, { preview: true })
  assert.equal(preview.ok, true)
  assert.equal(preview.preview.path, file)
  assert.equal(preview.preview.bytes, 4)
  assert.match(preview.preview.diff, /-old/)
  assert.match(preview.preview.diff, /\+new/)
  assert.equal(readFileSync(file, 'utf8'), 'old\n')

  const created = join(root, 'draft.txt')
  const draft = await service.invoke('fs.write', { path: created, text: 'draft' }, { preview: true })
  assert.equal(draft.ok, true)
  assert.equal(existsSync(created), false)

  // The agent tool exposes the same preview switch.
  const viaTool = await ctx._tools.get('act_invoke').execute({
    id: 'fs.write', args: { path: file, text: 'tool\n' }, preview: true,
  })
  assert.equal(viaTool.ok, true)
  assert.match(viaTool.preview.diff, /\+tool/)
  assert.equal(readFileSync(file, 'utf8'), 'old\n')
})

test('fs.write is atomic, returns an undoToken, and fs.undo restores the old content', async t => {
  const root = workdir(t)
  const file = join(root, 'doc.txt')
  writeFileSync(file, 'before')
  // Only fs.write is granted; the undo token itself authorizes the restore.
  const allow = { check: async request => ({ granted: request.capability === 'act:invoke:fs.write' }) }
  const { service } = setup(allow, { workdir: root })

  const written = await service.invoke('fs.write', { path: file, text: 'after' }, { subject: 'tester' })
  assert.equal(written.ok, true)
  assert.equal(written.result.path, file)
  assert.equal(written.result.bytes, 5)
  assert.match(written.result.undoToken, /^[0-9a-f-]{36}$/)
  assert.equal(readFileSync(file, 'utf8'), 'after')

  const undone = await service.invoke('fs.undo', { undoToken: written.result.undoToken })
  assert.equal(undone.ok, true)
  assert.deepEqual(undone.result, { path: file, restored: true, bytes: 6 })
  assert.equal(readFileSync(file, 'utf8'), 'before')

  // Tokens are single use.
  assert.equal((await service.invoke('fs.undo', { undoToken: written.result.undoToken })).reason, 'E_UNDO_TOKEN')
})

test('fs.undo removes a file created by fs.write', async t => {
  const root = workdir(t)
  const file = join(root, 'created.txt')
  const { service } = setup(allowAll, { workdir: root })
  const written = await service.invoke('fs.write', { path: file, text: 'one' }, { subject: 'tester' })
  assert.equal(written.ok, true)
  assert.equal(existsSync(file), true)
  const undone = await service.invoke('fs.undo', { undoToken: written.result.undoToken })
  assert.deepEqual(undone.result, { path: file, restored: false, bytes: 0 })
  assert.equal(existsSync(file), false)
})

test('fs.undo refuses to overwrite a file changed after the write', async t => {
  const root = workdir(t)
  const file = join(root, 'race.txt')
  writeFileSync(file, 'before')
  const { service } = setup(allowAll, { workdir: root })
  const written = await service.invoke('fs.write', { path: file, text: 'after' }, { subject: 'tester' })
  writeFileSync(file, 'external edit')
  const undone = await service.invoke('fs.undo', { undoToken: written.result.undoToken })
  assert.equal(undone.ok, false)
  assert.equal(undone.reason, 'E_UNDO_STALE')
  assert.equal(readFileSync(file, 'utf8'), 'external edit')
})

test('write and undo caps fail closed without issuing a token', async t => {
  const root = workdir(t)
  const big = join(root, 'big.txt')
  writeFileSync(big, 'x'.repeat(1024 * 1024 + 1))
  const { service } = setup(allowAll, { workdir: root, maxWriteBytes: 8 })

  const rejected = await service.invoke('fs.write', { path: join(root, 'small.txt'), text: '123456789' }, { subject: 'tester' })
  assert.equal(rejected.reason, 'E_TOO_LARGE')
  assert.equal(existsSync(join(root, 'small.txt')), false)

  const { service: normal } = setup(allowAll, { workdir: root })
  const written = await normal.invoke('fs.write', { path: big, text: 'tiny' }, { subject: 'tester' })
  assert.equal(written.ok, true)
  assert.equal(written.result.undoToken, null)
  assert.equal(written.result.undoable, false)
  assert.equal(written.result.reason, 'undo_limit')
})

test('act_list exposes each action risk', async () => {
  const { ctx } = setup()
  const listed = await ctx._tools.get('act_list').execute({})
  const risks = Object.fromEntries(listed.actions.map(action => [action.id, action.risk]))
  assert.equal(risks['fs.read'], 'read')
  assert.equal(risks['fs.write'], 'write')
  assert.equal(risks['fs.list'], 'read')
  assert.equal(risks['fs.undo'], 'write')
  assert.equal(risks.echo, 'read')
})
