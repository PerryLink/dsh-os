export const DEFAULT_PROFILE = 'web'

export function installCommand(name, profile = DEFAULT_PROFILE) {
  return `dsh plugin --profile ${profile} add ${name}`
}

export function updateCommand(name, profile = DEFAULT_PROFILE) {
  return `dsh plugin --profile ${profile} add ${name}@latest`
}

export function serviceLabel(service) {
  return service ? `ctx.${service}` : '-'
}

export function isSafeProfile(profile) {
  return (
    typeof profile === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(profile) &&
    profile !== '.' &&
    profile !== '..'
  )
}
