#!/usr/bin/env node
/**
 * dsh-check CLI — regression gate for paired DeepSeek Harness runs.
 *
 * 0.2.0 can launch the real headless runner (`run`) or diff two run JSON
 * files (`diff`). The runner needs a DSH checkout/bin and a model key.
 * @module dsh-check/bin
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { CheckRunner, DEFAULT_TIMEOUT_MS, compareRuns } from '../index.js'

const USAGE = `Usage:
  dsh-check diff --old <old.json> --new <new.json> [--json] [--allow-flaky <id>]...
  dsh-check run --tasks <check.tasks.json> --out <dir> --dsh-bin <path>
                [--profile headless] [--timeout ms] [--json]
  dsh-check init [dir]
  dsh-check list --file <check.tasks.json> [--json]

run needs a DSH checkout: pass --dsh-bin (the same file you would pass to
node), for example node_modules/.bin/dsh or apps/cli/lib/bin.js.
Exit codes: 0 pass/warnings, 1 regression or a failed run, 2 usage/input error.
Docs: https://github.com/PerryLink/dsh-os/tree/main/packages/check#readme`

const SAMPLE = {
  schema: 'dsh.check.tasks/v1',
  tasks: [
    ['session-token-summary', "Summarize this session's token usage by model."],
    ['repo-status', 'Report the workspace root, git branch and uncommitted files.'],
    ['test-failure-triage', 'Run the package tests and list failing tests with their first error.'],
  ].map(([id, prompt]) => ({ id, prompt })),
}

const usageError = message => Object.assign(new Error(message), { code: 'usage' })
const safeName = id => id.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '') || 'task'

function parse(argv) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      old: { type: 'string' },
      new: { type: 'string' },
      file: { type: 'string' },
      tasks: { type: 'string' },
      out: { type: 'string' },
      profile: { type: 'string' },
      timeout: { type: 'string' },
      'dsh-bin': { type: 'string' },
      json: { type: 'boolean', default: false },
      'allow-flaky': { type: 'string', multiple: true },
      help: { type: 'boolean', short: 'h' },
    },
  })
}

function readJson(file, label) {
  let text
  try {
    text = readFileSync(resolve(file), 'utf8')
  } catch (error) {
    throw new Error(`cannot read ${label} ${file}: ${error.message}`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`invalid JSON in ${label} ${file}: ${error.message}`)
  }
}

function tasksFrom(file, { requirePrompt = false } = {}) {
  const suite = readJson(file, 'tasks file')
  if (!suite || typeof suite !== 'object' || Array.isArray(suite) || !Array.isArray(suite.tasks)) {
    throw new Error('tasks file must be an object with a tasks array')
  }
  const ids = new Set()
  const tasks = suite.tasks.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || typeof item.id !== 'string' || item.id.trim() === '') {
      throw new Error('every task needs a non-empty string id')
    }
    if (ids.has(item.id)) throw new Error(`duplicate task id "${item.id}"`)
    ids.add(item.id)
    if (item.prompt !== undefined && typeof item.prompt !== 'string') {
      throw new Error(`task "${item.id}" prompt must be a string`)
    }
    if (requirePrompt && (typeof item.prompt !== 'string' || item.prompt.trim() === '')) {
      throw new Error(`task "${item.id}" needs a non-empty prompt`)
    }
    return { id: item.id, prompt: item.prompt ?? '' }
  })
  return { schema: suite.schema ?? 'dsh.check.tasks/v1', tasks }
}

function timeoutOf(value) {
  if (value === undefined) return DEFAULT_TIMEOUT_MS
  const timeoutMs = Number(value)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw usageError('--timeout must be a positive integer number of milliseconds')
  }
  return timeoutMs
}

function format(result) {
  const { summary } = result
  const lines = [
    `Check ${result.verdict.toUpperCase()}: ${summary.tasks} task(s), `
      + `${summary.regressions} regression(s), ${summary.warnings} warning(s), ${summary.ignored} ignored`,
  ]
  for (const task of result.tasks) {
    const label = task.ignored ? 'IGNORED' : task.verdict === 'warning' ? 'WARN' : task.verdict.toUpperCase()
    if (task.diffs.length === 0) lines.push(`  ${label} ${task.id}`)
    for (const diff of task.diffs) {
      lines.push(`  ${label} ${task.id} [${diff.dimension}/${diff.severity}] ${diff.message}`)
    }
  }
  return lines.join('\n')
}

function diffCommand(values) {
  if (!values.old || !values.new) throw usageError('diff requires --old and --new')
  const result = compareRuns(
    readJson(values.old, 'old run'),
    readJson(values.new, 'new run'),
    { allowFlaky: values['allow-flaky'] ?? [] },
  )
  process.stdout.write(`${values.json ? JSON.stringify(result, null, 2) : format(result)}\n`)
  return result.verdict === 'regression' ? 1 : 0
}

function initCommand(positionals) {
  if (positionals.length > 1) throw usageError('init takes an optional directory')
  const dir = resolve(positionals[0] ?? '.')
  const file = join(dir, 'check.tasks.json')
  if (existsSync(file)) throw new Error(`${file} already exists; refusing to overwrite`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, `${JSON.stringify(SAMPLE, null, 2)}\n`, 'utf8')
  process.stdout.write(`Created ${file} with 3 golden tasks.\n`)
  return 0
}

function listCommand(values, positionals) {
  if (positionals.length > 0) throw usageError('list takes flags only')
  if (!values.file) throw usageError('list requires --file <check.tasks.json>')
  const suite = tasksFrom(values.file)
  if (values.json) {
    process.stdout.write(`${JSON.stringify(suite, null, 2)}\n`)
  } else {
    for (const [index, task] of suite.tasks.entries()) {
      process.stdout.write(`${index + 1}. ${task.id}: ${task.prompt}\n`)
    }
  }
  return 0
}

function taskRecord(record, task) {
  const item = { id: task.id }
  if (record.ok || record.raw?.finalReason) item.result = record.result
  item.trajectory = record.trajectory
  item.cost = record.cost
  item.approvals = record.approvals
  item.exitCode = record.exitCode ?? null
  if (!record.ok) item.error = { code: record.code ?? 'failed' }
  return item
}

async function runCommand(values, positionals) {
  if (positionals.length > 0) throw usageError('run takes flags only')
  if (!values.tasks) throw usageError('run requires --tasks <check.tasks.json>')
  if (!values.out) throw usageError('run requires --out <directory>')
  if (!values['dsh-bin']) {
    process.stderr.write('dsh-check: 需要 DSH checkout：请用 --dsh-bin <path> 指定 DSH CLI 入口\n')
    return 2
  }
  const timeoutMs = timeoutOf(values.timeout)
  const suite = tasksFrom(values.tasks, { requirePrompt: true })
  if (suite.tasks.length === 0) throw usageError('tasks file has no tasks')
  const profile = values.profile ?? 'headless'
  const outDir = resolve(values.out)
  const runner = new CheckRunner({
    dshBin: values['dsh-bin'],
    profile,
    cwd: process.cwd(),
    timeoutMs,
  })
  mkdirSync(outDir, { recursive: true })
  const records = []
  const used = new Set()
  for (const task of suite.tasks) {
    const record = await runner.run(task)
    let name = safeName(task.id)
    if (used.has(name)) name = `${records.length + 1}-${name}`
    used.add(name)
    const file = join(outDir, `run-${name}.json`)
    const perTask = {
      schema: 'dsh.check.run/v1',
      environment: { label: `dsh-check runner / ${profile}`, profile, dshBin: values['dsh-bin'] },
      ok: record.ok,
      code: record.code,
      exitCode: record.exitCode ?? null,
      tasks: [taskRecord(record, task)],
    }
    writeFileSync(file, `${JSON.stringify(perTask, null, 2)}\n`, 'utf8')
    records.push({
      id: task.id,
      ok: record.ok,
      code: record.code ?? null,
      exitCode: record.exitCode ?? null,
      file,
    })
    if (!values.json) {
      const label = record.ok ? 'PASS' : 'FAIL'
      process.stdout.write(`${label} ${task.id}${record.code ? ` (${record.code})` : ''} -> ${file}\n`)
    }
  }
  const failed = records.filter(item => !item.ok).length
  const summary = {
    schema: 'dsh.check.run-summary/v1',
    profile,
    out: outDir,
    tasks: records,
    passed: records.length - failed,
    failed,
  }
  if (values.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  else process.stdout.write(`Check run: ${records.length} task(s), ${summary.passed} passed, ${failed} failed -> ${outDir}\n`)
  return failed > 0 ? 1 : 0
}

async function main(argv) {
  let parsed
  try {
    parsed = parse(argv)
  } catch (error) {
    process.stderr.write(`dsh-check: ${error.message}\n\n${USAGE}\n`)
    return 2
  }
  const { values, positionals } = parsed
  if (values.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (positionals.length === 0) {
    process.stderr.write(`${USAGE}\n`)
    return 2
  }
  const command = positionals[0]
  const rest = positionals.slice(1)
  try {
    if (command === 'diff') {
      if (rest.length > 0) throw usageError('diff takes flags only')
      return diffCommand(values)
    }
    if (command === 'run') return await runCommand(values, rest)
    if (command === 'init') return initCommand(rest)
    if (command === 'list') return listCommand(values, rest)
    throw usageError(`unknown command "${command}"`)
  } catch (error) {
    process.stderr.write(`dsh-check: ${error.message}\n`)
    if (error.code === 'usage') process.stderr.write(`\n${USAGE}\n`)
    return 2
  }
}

process.exitCode = await main(process.argv.slice(2))
