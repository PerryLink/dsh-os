/**
 * Clipboard adapters for dsh-snip.
 *
 * Every read runs a fixed argv list through an injected `runner` (a
 * `spawnSync` wrapper by default): no shell, no model/user input in argv, a
 * hard timeout and an environment stripped of tokens. Tests inject a fake
 * runner; importing this module never reads the real clipboard.
 * @module dsh-snip/capture
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

export const DEFAULT_TIMEOUT_MS = 5_000
export const DEFAULT_INTERVAL_MS = 700
export const DEFAULT_MAX_CHARS = 65_536

const SENSITIVE_ENV = /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i

/**
 * Windows PowerShell 5.1 reads text through WinRT; if WinRT is unavailable it
 * falls back to `Get-Clipboard -Raw`. stdout is ASCII-only: `TEXT:<base64>`,
 * `EMPTY`, `IMAGE` or `FILE`. Clipboard text never enters argv.
 */
const WINDOWS_SCRIPT = `$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
$marker = $null
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.ApplicationModel.DataTransfer.Clipboard, Windows.ApplicationModel.DataTransfer, ContentType=WindowsRuntime]
  $content = [Windows.ApplicationModel.DataTransfer.Clipboard]::GetContent()
  if ($null -eq $content) {
    $marker = 'EMPTY'
  } else {
    $formats = @($content.AvailableFormats)
    if ($formats -contains 'ExcludeClipboardContentFromMonitorProcessing') {
      $marker = 'EXCLUDED'
    } elseif ($formats -contains 'Text') {
      $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*' -and $_.GetParameters()[0].ParameterType.GetGenericArguments().Count -eq 1
      } | Select-Object -First 1
      if ($null -eq $asTask) { throw 'AsTask not found' }
      $task = $asTask.MakeGenericMethod([string]).Invoke($null, @($content.GetTextAsync()))
      if (-not $task.Wait(4000)) { throw 'clipboard read timed out' }
      $text = $task.Result
      if ([string]::IsNullOrWhiteSpace($text)) { $marker = 'EMPTY' }
      else { $marker = 'TEXT:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text)) }
    } elseif ($formats -contains 'Bitmap') {
      $marker = 'IMAGE'
    } elseif (($formats -contains 'FileDrop') -or ($formats -contains 'StorageItems')) {
      $marker = 'FILE'
    } else {
      $marker = 'EMPTY'
    }
  }
} catch {
  try {
    $fallback = Get-Clipboard -Raw -ErrorAction Stop
    if ([string]::IsNullOrWhiteSpace([string]$fallback)) { $marker = 'EMPTY' }
    else { $marker = 'TEXT:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$fallback)) }
  } catch {
    $marker = 'ERR:unavailable'
  }
}
Write-Output $marker
if ($marker -eq 'ERR:unavailable') { exit 1 }
`

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function positiveInteger(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 1 ? Math.floor(number) : fallback
}

/** SHA-256 of clipboard text, used only in memory and only for dedupe. */
export function hashText(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Strip DSH_* and token-looking variables before a child process sees them. */
function safeEnv(source = process.env) {
  const env = {}
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith('DSH_') || SENSITIVE_ENV.test(key)) continue
    env[key] = value
  }
  return env
}

/** Minimal PATH lookup; does not spawn `which`. */
function whichSync(command) {
  const pathValue = process.env.PATH ?? process.env.Path ?? ''
  if (!pathValue) return null
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue
    for (const extension of extensions) {
      const candidate = join(directory, extension && command.endsWith(extension) ? command : command + extension)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/**
 * Default runner. `spawnSync` is blocking, so callers must keep reads explicit
 * and short; tests always inject their own runner.
 */
export function spawnRunner(command, args, options = {}) {
  const result = spawnSync(command, args, {
    shell: false,
    windowsHide: true,
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: options.maxBuffer ?? 1024 * 1024,
    encoding: 'utf8',
    env: options.env ?? safeEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ? { code: result.error.code, message: result.error.message } : null,
  }
}

/**
 * Base adapter: availability probe, polling watch and text snapshot helpers.
 * Subclasses only implement `probe()` and `read()`.
 */
export class ClipboardAdapter {
  #runner
  #platform
  #timeoutMs
  #maxChars
  #intervalMs
  #available
  #timer = null

  constructor(options = {}) {
    this.#platform = options.platform ?? process.platform
    this.#runner = typeof options.runner === 'function' ? options.runner : spawnRunner
    this.#timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS)
    this.#maxChars = positiveInteger(options.maxChars, DEFAULT_MAX_CHARS)
    this.#intervalMs = positiveInteger(options.intervalMs, DEFAULT_INTERVAL_MS)
    this.#available = typeof options.available === 'boolean' ? options.available : undefined
  }

  get platform() {
    return this.#platform
  }

  get intervalMs() {
    return this.#intervalMs
  }

  /** `{ available: true }` or `{ available: false, reason }`; never throws. */
  available() {
    if (this.#available === false) return { available: false, reason: 'disabled by configuration' }
    if (this.#available === true) return { available: true }
    return this.probe()
  }

  probe() {
    return { available: false, reason: `clipboard unsupported on ${this.#platform}` }
  }

  read() {
    return {
      ok: false,
      code: 'SNIP_CLIPBOARD_UNSUPPORTED',
      reason: `clipboard unsupported on ${this.#platform}`,
    }
  }

  /** Poll `read()`; only real changes are forwarded by the service. */
  watch(onChange, options = {}) {
    if (typeof onChange !== 'function') throw fail('SNIP_BAD_WATCH', 'snip: watch callback must be a function')
    if (this.#timer !== null) return { watching: true, intervalMs: this.#intervalMs }
    const intervalMs = positiveInteger(options?.intervalMs, this.#intervalMs)
    this.#intervalMs = intervalMs
    this.#timer = setInterval(() => {
      let snapshot
      try {
        snapshot = this.read()
      } catch (error) {
        snapshot = { ok: false, code: typeof error?.code === 'string' ? error.code : 'SNIP_CLIPBOARD_FAILED' }
      }
      try {
        onChange(snapshot)
      } catch {}
    }, intervalMs)
    if (typeof this.#timer?.unref === 'function') this.#timer.unref()
    return { watching: true, intervalMs }
  }

  stop() {
    if (this.#timer === null) return false
    clearInterval(this.#timer)
    this.#timer = null
    return true
  }

  /** Run one fixed argv through the injected runner; stderr/error text is dropped. */
  exec(command, args) {
    const options = {
      timeoutMs: this.#timeoutMs,
      maxBuffer: Math.max(1024, this.#maxChars * 8),
      env: safeEnv(),
      shell: false,
      windowsHide: true,
    }
    let result
    try {
      result = this.#runner(command, args, options) ?? {}
    } catch {
      return { ok: false, code: 'SNIP_CLIPBOARD_FAILED', reason: 'clipboard runner failed' }
    }
    if (result.error?.code === 'ETIMEDOUT' || result.timedOut === true) {
      return { ok: false, code: 'SNIP_CLIPBOARD_TIMEOUT', reason: 'clipboard read timed out' }
    }
    if (typeof result.status === 'number' && result.status !== 0) {
      return { ok: false, code: 'SNIP_CLIPBOARD_FAILED', reason: `clipboard command exited ${result.status}` }
    }
    if (result.status === null && result.stdout == null) {
      return { ok: false, code: 'SNIP_CLIPBOARD_FAILED', reason: 'clipboard command did not start' }
    }
    return { ok: true, stdout: typeof result.stdout === 'string' ? result.stdout : String(result.stdout ?? '') }
  }

  /** Normalise raw text into a snapshot, truncating at `maxChars`. */
  snapshotOf(text) {
    if (typeof text !== 'string' || text.trim().length === 0) return { ok: true, kind: 'empty' }
    if (text.length > this.#maxChars) {
      return { ok: true, kind: 'text', text: text.slice(0, this.#maxChars), truncated: true }
    }
    return { ok: true, kind: 'text', text }
  }
}

/** Windows: WinRT `GetContent` with a `Get-Clipboard -Raw` fallback. */
export class WindowsClipboardAdapter extends ClipboardAdapter {
  constructor(options = {}) {
    super({ ...options, platform: 'win32' })
  }

  probe() {
    if (!whichSync('powershell.exe')) {
      return { available: false, reason: 'powershell.exe not found' }
    }
    return { available: true }
  }

  read() {
    const result = this.exec('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      WINDOWS_SCRIPT,
    ])
    if (!result.ok) return result
    const lines = result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    const marker = lines.findLast(line =>
      line === 'EMPTY' || line === 'IMAGE' || line === 'FILE' || line === 'EXCLUDED' || line.startsWith('TEXT:'))
    if (marker === undefined) {
      return { ok: false, code: 'SNIP_CLIPBOARD_FAILED', reason: 'unexpected clipboard helper output' }
    }
    if (marker === 'EMPTY') return { ok: true, kind: 'empty' }
    if (marker === 'IMAGE') return { ok: true, kind: 'image' }
    if (marker === 'FILE') return { ok: true, kind: 'file' }
    if (marker === 'EXCLUDED') {
      return { ok: false, code: 'SNIP_CLIPBOARD_EXCLUDED', reason: 'clipboard content opted out of monitoring' }
    }
    return this.snapshotOf(Buffer.from(marker.slice(5), 'base64').toString('utf8'))
  }
}

/** macOS: one `/usr/bin/pbpaste` read. It cannot see images or source markers. */
export class MacClipboardAdapter extends ClipboardAdapter {
  constructor(options = {}) {
    super({ ...options, platform: 'darwin' })
  }

  probe() {
    if (!whichSync('pbpaste')) return { available: false, reason: 'pbpaste not found' }
    return { available: true }
  }

  read() {
    const result = this.exec('pbpaste', [])
    return result.ok ? this.snapshotOf(result.stdout) : result
  }
}

/** Linux: `wl-paste` on Wayland, `xclip` on X11. */
export class LinuxClipboardAdapter extends ClipboardAdapter {
  #backend

  constructor(options = {}) {
    super({ ...options, platform: 'linux' })
    this.#backend = options.backend === 'wl-paste' || options.backend === 'xclip' ? options.backend : null
  }

  get backend() {
    if (this.#backend) return this.#backend
    if (process.env.WAYLAND_DISPLAY && whichSync('wl-paste')) return 'wl-paste'
    if (process.env.DISPLAY && whichSync('xclip')) return 'xclip'
    return null
  }

  probe() {
    const backend = this.backend
    if (backend) return { available: true, backend }
    return { available: false, reason: 'wl-paste or xclip not found (Wayland/X11)' }
  }

  read() {
    const backend = this.backend
    if (backend === 'wl-paste') {
      const result = this.exec('wl-paste', ['--no-newline'])
      return result.ok ? this.snapshotOf(result.stdout) : result
    }
    if (backend === 'xclip') {
      const result = this.exec('xclip', ['-selection', 'clipboard', '-o'])
      return result.ok ? this.snapshotOf(result.stdout) : result
    }
    return { ok: false, code: 'SNIP_CLIPBOARD_UNAVAILABLE', reason: 'no Wayland or X11 clipboard tool' }
  }
}

/** Build the adapter for `options.platform` (defaults to the host platform). */
export function createClipboardAdapter(options = {}) {
  const platform = options.platform ?? process.platform
  const shared = { ...options, platform }
  if (platform === 'win32') return new WindowsClipboardAdapter(shared)
  if (platform === 'darwin') return new MacClipboardAdapter(shared)
  if (platform === 'linux') return new LinuxClipboardAdapter(shared)
  return new ClipboardAdapter(shared)
}

export { createClipboardAdapter as createAdapter }
