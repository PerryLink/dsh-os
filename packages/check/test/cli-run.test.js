import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BIN = join(ROOT, 'bin', 'dsh-check.js')
const FAKE_DSH = join(ROOT, 'test-support', 'fake-dsh.mjs')
const cli = args => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' })

function workspace(tasks) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-check-run-'))
  const file = join(dir, 'check.tasks.json')
  writeFileSync(file, JSON.stringify({ schema: 'dsh.check.tasks/v1', tasks }))
  return { dir, file, out: join(dir, 'out'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('run without --dsh-bin prints 需要 DSH checkout and exits 2', () => {
  const space = workspace([{ id: 'a', prompt: 'hi' }])
  try {
    const result = cli(['run', '--tasks', space.file, '--out', space.out])
    assert.equal(result.status, 2)
    assert.match(result.stderr, /需要 DSH checkout/)
    assert.equal(existsSync(space.out), false)
  } finally {
    space.cleanup()
  }
})

test('run writes one diffable run-<id>.json per task and a --json summary', () => {
  const space = workspace([
    { id: 'alpha', prompt: 'say pong' },
    { id: 'beta', prompt: 'say ping' },
  ])
  try {
    const result = cli([
      'run', '--tasks', space.file, '--out', space.out,
      '--dsh-bin', FAKE_DSH, '--profile', 'headless', '--timeout', '60000', '--json',
    ])
    assert.equal(result.status, 0, result.stderr)
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.schema, 'dsh.check.run-summary/v1')
    assert.equal(summary.profile, 'headless')
    assert.deepEqual([summary.passed, summary.failed], [2, 0])
    assert.deepEqual(summary.tasks.map(item => item.id), ['alpha', 'beta'])

    for (const task of [{ id: 'alpha', prompt: 'say pong' }, { id: 'beta', prompt: 'say ping' }]) {
      const file = join(space.out, `run-${task.id}.json`)
      assert.equal(existsSync(file), true)
      const run = JSON.parse(readFileSync(file, 'utf8'))
      assert.equal(run.schema, 'dsh.check.run/v1')
      assert.equal(run.ok, true)
      assert.equal(run.tasks.length, 1)
      assert.equal(run.tasks[0].id, task.id)
      assert.equal(run.tasks[0].result.text, `pong: ${task.prompt}`)
      assert.deepEqual(run.tasks[0].trajectory, { steps: 1, toolCalls: 1, errors: 0 })
      assert.equal(run.tasks[0].exitCode, 0)
    }
  } finally {
    space.cleanup()
  }
})

test('run exits 1 and records the failure when a task run fails', () => {
  const space = workspace([{ id: 'boom', prompt: 'FAIL now' }])
  try {
    const result = cli(['run', '--tasks', space.file, '--out', space.out, '--dsh-bin', FAKE_DSH, '--json'])
    assert.equal(result.status, 1, result.stderr)
    const summary = JSON.parse(result.stdout)
    assert.deepEqual([summary.passed, summary.failed], [0, 1])
    assert.equal(summary.tasks[0].code, 'exit_nonzero')
    const run = JSON.parse(readFileSync(join(space.out, 'run-boom.json'), 'utf8'))
    assert.equal(run.ok, false)
    assert.equal(run.code, 'exit_nonzero')
    assert.equal(run.tasks[0].error.code, 'exit_nonzero')
  } finally {
    space.cleanup()
  }
})

test('run rejects missing flags, a bad timeout and missing prompts', () => {
  const space = workspace([{ id: 'no-prompt' }])
  try {
    assert.equal(cli(['run', '--out', space.out, '--dsh-bin', FAKE_DSH]).status, 2)
    assert.equal(cli(['run', '--tasks', space.file, '--dsh-bin', FAKE_DSH]).status, 2)
    const badTimeout = cli(['run', '--tasks', space.file, '--out', space.out, '--dsh-bin', FAKE_DSH, '--timeout', 'soon'])
    assert.equal(badTimeout.status, 2)
    assert.match(badTimeout.stderr, /--timeout/)
    const noPrompt = cli(['run', '--tasks', space.file, '--out', space.out, '--dsh-bin', FAKE_DSH])
    assert.equal(noPrompt.status, 2)
    assert.match(noPrompt.stderr, /non-empty prompt/)
  } finally {
    space.cleanup()
  }
})

test('run rejects duplicate task ids before spawning', () => {
  const space = workspace([{ id: 'dup', prompt: 'a' }, { id: 'dup', prompt: 'b' }])
  try {
    const result = cli(['run', '--tasks', space.file, '--out', space.out, '--dsh-bin', FAKE_DSH])
    assert.equal(result.status, 2)
    assert.match(result.stderr, /duplicate task id/)
  } finally {
    space.cleanup()
  }
})
