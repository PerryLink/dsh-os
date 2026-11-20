import { spawnSync } from 'node:child_process'
import { formatDoctor, runDoctor } from './doctor.mjs'
import { allEntries, listEntries, resolveModule } from './modules.mjs'
import { installCommand, serviceLabel, updateCommand } from './names.mjs'

function listedModule(entry) {
  const module = {
    name: entry.name,
    product: entry.product,
    service: entry.service,
    version: entry.version,
    stability: entry.stability,
    description: entry.description,
  }
  if (entry.optional) module.optional = true
  return module
}

function renderTable(entries) {
  const headers = ['NAME', 'PRODUCT', 'SERVICE', 'VERSION', 'STABILITY', 'DESCRIPTION']
  const rows = entries.map(entry => [
    entry.name,
    entry.product,
    serviceLabel(entry.service),
    entry.version,
    entry.stability,
    entry.description,
  ])
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map(row => row[index].length)),
  )
  const renderRow = row =>
    row
      .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index])))
      .join('  ')
      .trimEnd()
  return `${[headers, ...rows].map(renderRow).join('\n')}\n`
}

export function runList(context, options, stdout) {
  const entries = listEntries(context, options.all)
  if (options.json) {
    stdout.write(`${JSON.stringify(entries.map(listedModule), null, 2)}\n`)
    return 0
  }
  stdout.write(renderTable(entries))
  if (options.all && context.optional.length > 0) {
    stdout.write('\nOptional/planned modules are listed above but are not published yet.\n')
  }
  return 0
}

export function runInfo(context, spec, options, stdout) {
  const entry = resolveModule(spec, allEntries(context, true))
  if (!entry) throw new Error(`unknown module "${spec}"`)

  const install = installCommand(entry.name, options.profile)
  const update = updateCommand(entry.name, options.profile)
  if (options.json) {
    const detail = listedModule(entry)
    detail.install = install
    detail.update = update
    stdout.write(`${JSON.stringify(detail, null, 2)}\n`)
    return 0
  }

  const fields = [
    ['package', entry.name],
    ['service', serviceLabel(entry.service)],
    ['version', entry.version],
    ['stability', entry.stability],
    ['description', entry.description],
  ]
  if (entry.optional) fields.push(['optional', 'yes (planned; not yet published)'])
  fields.push(['install', install], ['update', update])
  const width = Math.max(...fields.map(([label]) => label.length)) + 2
  const lines = [entry.product]
  for (const [label, value] of fields) {
    lines.push(`  ${`${label}:`.padEnd(width)}${value}`)
  }
  stdout.write(`${lines.join('\n')}\n`)
  return 0
}

export function runInstall(context, specs, options, stdout) {
  const available = allEntries(context, true)
  const selected = []
  const seen = new Set()
  for (const spec of specs) {
    const entry = resolveModule(spec, available)
    if (!entry) throw new Error(`unknown module "${spec}"`)
    if (entry.optional) {
      throw new Error(`module "${entry.name}" is optional/planned and is not published yet`)
    }
    if (seen.has(entry.name)) continue
    seen.add(entry.name)
    selected.push(entry)
  }

  const commands = selected.map(entry => ({
    command: installCommand(entry.name, options.profile),
    argv: ['plugin', '--profile', options.profile, 'add', entry.name],
  }))

  if (!options.run) {
    for (const item of commands) stdout.write(`${item.command}\n`)
    return 0
  }

  for (const item of commands) {
    stdout.write(`${item.command}\n`)
    const result = spawnSync('dsh', item.argv, { stdio: 'inherit', shell: false })
    if (result.error) throw new Error(`failed to start dsh: ${result.error.message}`)
    if (result.status !== 0) return result.status ?? 1
  }
  return 0
}

export function runUpdate(context, options, stdout) {
  for (const entry of context.entries) {
    stdout.write(`${updateCommand(entry.name, options.profile)}\n`)
  }
  return 0
}

export function runDoctorCommand(context, stdout) {
  const result = runDoctor(context)
  stdout.write(formatDoctor(result, context))
  return result.errors > 0 ? 1 : 0
}
