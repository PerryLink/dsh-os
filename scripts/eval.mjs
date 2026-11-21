#!/usr/bin/env node
/**
 * Gate: run all dsh-os evals and fail when task success is below threshold.
 * Usage: node scripts/eval.mjs [--threshold=0.5]
 * Env:   EVAL_THRESHOLD=0.5
 */
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runAll, writeReports } from '../evals/run.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const value = args.find(arg => arg.startsWith('--threshold='))?.split('=')[1] ?? process.env.EVAL_THRESHOLD ?? '0.5'
const threshold = Number(value)
if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
  console.error(`invalid threshold: ${value} (expected 0..1)`)
  process.exit(2)
}
if (args.includes('--real')) {
  const { spawnSync } = await import('node:child_process')
  const script = fileURLToPath(new URL('../evals/real-run.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [script, ...args.filter(arg => arg !== '--real')], { stdio: 'inherit' })
  process.exit(result.status ?? 1)
}
const report = await runAll()
const paths = writeReports(report)
const m = report.metrics
console.log(`success ${m.successes}/${m.scenarios} = ${(m.successRate * 100).toFixed(1)}% (threshold ${(threshold * 100).toFixed(0)}%)`)
console.log(`steps=${m.avgSteps.toFixed(1)} invalid=${(m.invalidCallRate * 100).toFixed(1)}% recovery=${(m.recoveryRate * 100).toFixed(1)}% first-step=${(m.firstStepAccuracy * 100).toFixed(1)}% interventions=${m.interventions}`)
console.log(`report: ${relative(ROOT, paths.json)} / ${relative(ROOT, paths.md)}`)
if (m.successRate < threshold) {
  console.error(`below threshold: ${(m.successRate * 100).toFixed(1)}% < ${(threshold * 100).toFixed(0)}%`)
  process.exit(1)
}
