#!/usr/bin/env node
/**
 * dsh-check CLI — regression gate for paired DeepSeek Harness runs.
 *
 * 0.1.0 only diffs run JSON files; it never launches DSH or calls a model.
 * The headless runner lands in 0.2.0.
 * @module dsh-check/bin
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { compareRuns } from '../index.js'

const USAGE = `Usage:
  dsh-check diff --old <old.json> --new <new.json> [--json] [--allow-flaky <id>]...
  dsh-check init [dir]
  dsh-check list --file <check.tasks.json> [--json]

Exit codes: 0 pass/warnings, 1 regression, 2 usage or input error.
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

function parse(argv) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      old: { type: 'string' },
      new: { type: 'string' },
      file: { type: 'string' },
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

function format(result) {
  const { summary } = result
  const lines = [
    `Check ${result.verdict.toUpperCase()}: ${summary.tasks} task(s), `
      + `${summary.regressions} regression(s), ${summary.warnings} warning(s), ${summary.ignored} ignored`,
  ]
  for (const task of result.tasks) {
    const label = task.ignored ? 'IGNORED' : task.verdict.toUpperCase()
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
  const suite = readJson(values.file, 'tasks file')
  if (!suite || typeof suite !== 'object' || Array.isArray(suite) || !Array.isArray(suite.tasks)) {
    throw new Error('tasks file must be an object with a tasks array')
  }
  const ids = new Set()
  const tasks = suite.tasks.map(task => {
    if (!task || typeof task !== 'object' || Array.isArray(task)
      || typeof task.id !== 'string' || task.id.trim() === '') {
      throw new Error('every task needs a non-empty string id')
    }
    if (ids.has(task.id)) throw new Error(`duplicate task id "${task.id}"`)
    ids.add(task.id)
    if (task.prompt !== undefined && typeof task.prompt !== 'string') {
      throw new Error(`task "${task.id}" prompt must be a string`)
    }
    return { id: task.id, prompt: task.prompt ?? '' }
  })
  if (values.json) {
    process.stdout.write(`${JSON.stringify({ schema: suite.schema ?? 'dsh.check.tasks/v1', tasks }, null, 2)}\n`)
  } else {
    for (const [index, task] of tasks.entries()) process.stdout.write(`${index + 1}. ${task.id}: ${task.prompt}\n`)
  }
  return 0
}

function main(argv) {
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
    if (command === 'init') return initCommand(rest)
    if (command === 'list') return listCommand(values, rest)
    throw usageError(`unknown command "${command}"`)
  } catch (error) {
    process.stderr.write(`dsh-check: ${error.message}\n`)
    if (error.code === 'usage') process.stderr.write(`\n${USAGE}\n`)
    return 2
  }
}

process.exitCode = main(process.argv.slice(2))
