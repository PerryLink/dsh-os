import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { apply, BackupService, makeTools } from '../index.js'

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-backup-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

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

const throwsCode = expected => error => error instanceof Error && error.code === expected

function fixture(root) {
  mkdirSync(join(root, 'nested', 'deep'), { recursive: true })
  writeFileSync(join(root, 'a.txt'), 'alpha')
  writeFileSync(join(root, 'nested', 'b.txt'), 'bravo!')
  writeFileSync(join(root, 'nested', 'deep', 'c.txt'), '')
}

test('apply provides ctx.backup and registers exactly three tools', () => {
  const ctx = fakeContext()
  const service = apply(ctx)
  assert.ok(service instanceof BackupService)
  assert.equal(ctx.get('backup'), service)
  assert.deepEqual([...ctx._tools.keys()], ['backup_snapshot', 'backup_diff', 'backup_plan_restore'])
  assert.equal(makeTools(service).length, 3)
  for (const definition of makeTools(service)) {
    assert.equal(definition.parameters.type, 'object')
    assert.equal(definition.parameters.additionalProperties, false)
    assert.equal(typeof definition.execute, 'function')
    assert.equal(typeof definition.output.render, 'function')
  }
})

test('apply keeps the service usable without a tool registry', () => {
  const services = new Map()
  const service = apply({ provide: (name, value) => services.set(name, value) })
  assert.equal(services.get('backup'), service)
  assert.equal(service.list().length, 0)
})

test('snapshot records counts, metadata and absolute entry paths', t => {
  const root = sandbox(t)
  fixture(root)
  const service = new BackupService()
  const manifest = service.snapshot({ root })
  assert.match(manifest.id, /^bkp_/)
  assert.equal(manifest.schema, 'dsh.backup.snapshot/v1')
  assert.equal(manifest.root, resolve(root))
  assert.equal(manifest.hash, null)
  assert.deepEqual(manifest.include, [])
  assert.deepEqual(manifest.exclude, [])
  assert.deepEqual(manifest.counts, { files: 3, dirs: 2, symlinks: 0, bytes: 11 })
  assert.deepEqual(manifest.entries.map(entry => entry.rel), [
    'a.txt', 'nested', 'nested/b.txt', 'nested/deep', 'nested/deep/c.txt',
  ])
  const file = manifest.entries[0]
  assert.equal(file.type, 'file')
  assert.equal(file.path, join(resolve(root), 'a.txt'))
  assert.equal(file.size, 5)
  assert.ok(file.mtimeMs > 0)
  assert.equal(typeof file.mode, 'number')
  assert.equal(service.get(manifest.id).counts.files, 3)
  assert.equal(service.get(manifest.id).entries[0].path, join(resolve(root), 'a.txt'))
})

test('get returns defensive copies and null for unknown ids', t => {
  const root = sandbox(t)
  fixture(root)
  const service = new BackupService()
  const manifest = service.snapshot({ root })
  manifest.entries[0].size = 999
  assert.equal(service.get(manifest.id).entries[0].size, 5)
  assert.equal(service.get('bkp_missing'), null)
  assert.throws(() => service.get(''), throwsCode('E_INVALID_ARGUMENT'))
})

test('sha256 hashes are optional and hashed from file contents', t => {
  const root = sandbox(t)
  writeFileSync(join(root, 'a.txt'), 'alpha')
  const service = new BackupService({ hash: 'sha256' })
  const manifest = service.snapshot({ root })
  assert.equal(manifest.hash, 'sha256')
  assert.equal(
    manifest.entries[0].hash,
    createHash('sha256').update('alpha').digest('hex'),
  )
  assert.throws(() => new BackupService({ hash: 'md5' }), throwsCode('E_INVALID_ARGUMENT'))
})

test('file and byte limits fail closed with E_LIMIT', t => {
  const root = sandbox(t)
  fixture(root)
  assert.throws(
    () => new BackupService({ maxFiles: 2 }).snapshot({ root }),
    throwsCode('E_LIMIT'),
  )
  assert.throws(
    () => new BackupService({ maxBytes: 4 }).snapshot({ root }),
    throwsCode('E_LIMIT'),
  )
  assert.throws(
    () => new BackupService().snapshot({ root, maxFiles: 1 }),
    throwsCode('E_LIMIT'),
  )
})

test('absolute paths and .. traversal are rejected', t => {
  const root = sandbox(t)
  fixture(root)
  const service = new BackupService()
  assert.throws(() => service.snapshot({ root: 'relative' }), throwsCode('E_INVALID_ARGUMENT'))
  assert.throws(
    () => service.snapshot({ root: `${root}/../elsewhere` }),
    throwsCode('E_INVALID_ARGUMENT'),
  )
  assert.throws(
    () => service.snapshot({ root, include: ['../secret'] }),
    throwsCode('E_INVALID_ARGUMENT'),
  )
  assert.throws(
    () => service.snapshot({ root, exclude: [join(root, 'a.txt')] }),
    throwsCode('E_INVALID_ARGUMENT'),
  )
  assert.throws(() => service.snapshot({ root: join(root, 'missing') }), throwsCode('E_NOT_FOUND'))
  assert.throws(() => service.snapshot({ root: join(root, 'a.txt') }), throwsCode('E_INVALID_ARGUMENT'))
})

test('include filters files and prunes empty directories', t => {
  const root = sandbox(t)
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'docs'))
  mkdirSync(join(root, 'skip'))
  writeFileSync(join(root, 'src', 'a.js'), 'a')
  writeFileSync(join(root, 'src', 'b.txt'), 'b')
  writeFileSync(join(root, 'docs', 'c.md'), 'c')
  writeFileSync(join(root, 'skip', 'd.js'), 'd')
  const service = new BackupService()
  const manifest = service.snapshot({ root, include: ['**/*.js'] })
  assert.deepEqual(manifest.entries.map(entry => entry.rel), ['skip', 'skip/d.js', 'src', 'src/a.js'])
  assert.equal(manifest.counts.files, 2)
  const excluded = service.snapshot({ root, exclude: ['skip'] })
  assert.deepEqual(excluded.entries.map(entry => entry.rel), [
    'docs', 'docs/c.md', 'src', 'src/a.js', 'src/b.txt',
  ])
})

test('symlinks are recorded without being followed', t => {
  const root = sandbox(t)
  writeFileSync(join(root, 'a.txt'), 'alpha')
  try {
    symlinkSync('a.txt', join(root, 'link.txt'))
  } catch {
    t.skip('symlinks unavailable on this platform')
    return
  }
  const manifest = new BackupService().snapshot({ root })
  const link = manifest.entries.find(entry => entry.rel === 'link.txt')
  assert.equal(link.type, 'symlink')
  assert.equal(link.target, 'a.txt')
  assert.equal(manifest.counts.symlinks, 1)
  assert.equal(manifest.counts.files, 1)
})

test('diff reports added, removed and changed relative paths', t => {
  const root = sandbox(t)
  writeFileSync(join(root, 'keep.txt'), 'keep')
  writeFileSync(join(root, 'change.txt'), 'one')
  writeFileSync(join(root, 'gone.txt'), 'bye')
  const service = new BackupService()
  const first = service.snapshot({ root })
  writeFileSync(join(root, 'change.txt'), 'one-longer')
  writeFileSync(join(root, 'add.txt'), 'added')
  rmSync(join(root, 'gone.txt'))
  const second = service.snapshot({ root })
  const diff = service.diff(first.id, second.id)
  assert.equal(diff.schema, 'dsh.backup.diff/v1')
  assert.deepEqual(diff.added, ['add.txt'])
  assert.deepEqual(diff.removed, ['gone.txt'])
  assert.deepEqual(diff.changed, ['change.txt'])
  assert.equal(diff.changes.length, 1)
  assert.ok(diff.changes[0].fields.includes('size'))
  assert.equal(diff.changes[0].from.size, 3)
  assert.equal(diff.changes[0].to.size, 10)
  assert.equal(diff.counts.added, 1)
  assert.equal(diff.counts.removed, 1)
  assert.equal(diff.counts.changed, 1)
  assert.equal(diff.counts.unchanged, 1)
  assert.throws(() => service.diff(first.id, 'bkp_missing'), throwsCode('E_NOT_FOUND'))
})

test('planRestore lists add, overwrite and delete without writing', t => {
  const root = sandbox(t)
  writeFileSync(join(root, 'keep.txt'), 'keep')
  writeFileSync(join(root, 'change.txt'), 'old')
  const service = new BackupService()
  const manifest = service.snapshot({ root })
  const target = sandbox(t)
  writeFileSync(join(target, 'change.txt'), 'old but longer')
  writeFileSync(join(target, 'extra.txt'), 'extra')
  const before = readFileSync(join(target, 'change.txt'), 'utf8')
  const plan = service.planRestore(manifest.id, { target })
  assert.equal(plan.schema, 'dsh.backup.plan/v1')
  assert.equal(plan.execute, false)
  assert.equal(plan.target, resolve(target))
  assert.deepEqual(plan.add, [join(resolve(target), 'keep.txt')])
  assert.deepEqual(plan.overwrite, [join(resolve(target), 'change.txt')])
  assert.deepEqual(plan.delete, [join(resolve(target), 'extra.txt')])
  assert.equal(plan.counts.add, 1)
  assert.equal(plan.counts.overwrite, 1)
  assert.equal(plan.counts.delete, 1)
  assert.equal(readFileSync(join(target, 'change.txt'), 'utf8'), before)
  assert.equal(existsSync(join(target, 'keep.txt')), false)
  assert.throws(() => service.planRestore('bkp_missing', { target }), throwsCode('E_NOT_FOUND'))
  assert.throws(() => service.planRestore(manifest.id, { target: 'relative' }), throwsCode('E_INVALID_ARGUMENT'))
  assert.throws(
    () => service.planRestore(manifest.id, { target: `${target}/../escape` }),
    throwsCode('E_INVALID_ARGUMENT'),
  )
})

test('planRestore against the source reports only unchanged entries', t => {
  const root = sandbox(t)
  fixture(root)
  const service = new BackupService()
  const manifest = service.snapshot({ root })
  const plan = service.planRestore(manifest.id, { target: root })
  assert.deepEqual(plan.add, [])
  assert.deepEqual(plan.overwrite, [])
  assert.deepEqual(plan.delete, [])
  assert.equal(plan.counts.unchanged, manifest.entries.length)
})

test('planRestore handles a missing target without creating it', t => {
  const root = sandbox(t)
  fixture(root)
  const service = new BackupService()
  const manifest = service.snapshot({ root })
  const target = join(root, 'new-target')
  const plan = service.planRestore(manifest.id, { target })
  assert.equal(existsSync(target), false)
  assert.deepEqual(plan.add, manifest.entries.map(entry => join(target, entry.rel)))
  assert.deepEqual(plan.delete, [])
})

test('forget removes a manifest and reports whether it existed', t => {
  const root = sandbox(t)
  fixture(root)
  const service = new BackupService()
  const manifest = service.snapshot({ root })
  assert.equal(service.list().length, 1)
  assert.equal(service.forget(manifest.id), true)
  assert.equal(service.get(manifest.id), null)
  assert.equal(service.forget(manifest.id), false)
  assert.equal(service.list().length, 0)
  assert.throws(
    () => service.planRestore(manifest.id, { target: join(root, 'target') }),
    throwsCode('E_NOT_FOUND'),
  )
})

test('list returns entry-free summaries and the tool surface works end to end', async t => {
  const root = sandbox(t)
  fixture(root)
  const service = new BackupService()
  const tools = new Map(makeTools(service).map(definition => [definition.name, definition]))
  const snapshot = await tools.get('backup_snapshot').execute({ root })
  assert.equal(snapshot.counts.files, 3)
  const summaries = service.list()
  assert.equal(summaries.length, 1)
  assert.equal(summaries[0].entries, undefined)
  assert.equal(summaries[0].id, snapshot.id)
  const diff = await tools.get('backup_diff').execute({ idA: snapshot.id, idB: snapshot.id })
  assert.deepEqual(diff.added, [])
  const plan = await tools.get('backup_plan_restore').execute({ id: snapshot.id, target: root })
  assert.equal(plan.execute, false)
  assert.equal(plan.counts.unchanged, snapshot.entries.length)
})
