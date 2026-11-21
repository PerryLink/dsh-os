#!/usr/bin/env node
/** Run the runnable examples; fail if either demo regresses. */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const runs = [
  ['os-kit', process.execPath, [join(ROOT, 'examples/os-kit/demo.mjs')]],
  ['check-demo', process.platform === 'win32' ? 'bash' : 'bash', [join(ROOT, 'examples/os-kit/check-demo/run-check-demo.sh')]],
]
let failed = 0
for (const [name, cmd, args] of runs) {
  const result = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8' })
  const ok = result.status === 0
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} (exit ${result.status})`)
  if (!ok) {
    console.log((result.stdout || '').split('\n').slice(-15).join('\n'))
    console.log((result.stderr || '').split('\n').slice(-10).join('\n'))
    failed += 1
  }
}
console.log(`examples-smoke: ${runs.length - failed}/${runs.length} passed`)
process.exit(failed === 0 ? 0 : 1)
