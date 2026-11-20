/**
 * Windows adapter: one fixed PowerShell program that compiles a small C#
 * P/Invoke surface (`Add-Type`) and performs DPI setup, enumeration and
 * writes in a single child process.
 *
 * Coordinates are physical pixels: the process opts into PMv2 before any
 * window/monitor API, and observed bounds are DWM extended-frame bounds (the
 * rectangle the user sees). `SetWindowPos` writes the outer frame, so the
 * adapter expands a target by the measured invisible border first.
 */
import {
  asRect, displayForRect, expectOk, insetOf, isRect, resolveRunner, runAdapter,
  sameRect, sameSize, StageAdapterError,
} from './base.js'

/** The fixed PowerShell program. The request arrives as JSON in DSH_STAGE_REQUEST. */
export const PS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Reply($value) { [Console]::Out.WriteLine(($value | ConvertTo-Json -Compress -Depth 8)) }

$request = $null
try { $request = $env:DSH_STAGE_REQUEST | ConvertFrom-Json } catch { $request = $null }
if ($null -eq $request) { Reply @{ ok = $false; code = 'E_UNAVAILABLE'; reason = 'bad_request' }; exit 0 }

try {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class StageWin32
{
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  public delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, ref RECT rect, IntPtr data);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  [StructLayout(LayoutKind.Sequential)]
  public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }

  public class WinInfo
  {
    public long Hwnd;
    public uint Pid;
    public bool Minimized;
    public bool Focused;
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
    public int FrameLeft;
    public int FrameTop;
    public int FrameRight;
    public int FrameBottom;
    public uint Dpi;
  }

  public class MonitorInfo
  {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
    public int WorkLeft;
    public int WorkTop;
    public int WorkRight;
    public int WorkBottom;
    public uint Dpi;
    public bool Primary;
  }

  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern IntPtr GetThreadDpiAwarenessContext();
  [DllImport("user32.dll")] public static extern bool AreDpiAwarenessContextsEqual(IntPtr left, IntPtr right);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc callback, IntPtr data);
  [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out RECT rect, int size);
  [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint dpiX, out uint dpiY);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);

  public static bool EnableDpi()
  {
    try { return SetProcessDpiAwarenessContext(new IntPtr(-4)); }
    catch { return false; }
  }

  public static List<MonitorInfo> Monitors()
  {
    List<MonitorInfo> list = new List<MonitorInfo>();
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate(IntPtr monitor, IntPtr hdc, ref RECT rect, IntPtr data)
    {
      MONITORINFO info = new MONITORINFO();
      info.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
      if (!GetMonitorInfo(monitor, ref info)) return true;
      uint dx = 96;
      uint dy = 96;
      try { GetDpiForMonitor(monitor, 0, out dx, out dy); } catch { dx = 96; }
      MonitorInfo item = new MonitorInfo();
      item.Left = info.rcMonitor.Left;
      item.Top = info.rcMonitor.Top;
      item.Right = info.rcMonitor.Right;
      item.Bottom = info.rcMonitor.Bottom;
      item.WorkLeft = info.rcWork.Left;
      item.WorkTop = info.rcWork.Top;
      item.WorkRight = info.rcWork.Right;
      item.WorkBottom = info.rcWork.Bottom;
      item.Dpi = dx;
      item.Primary = (info.dwFlags & 1) == 1;
      list.Add(item);
      return true;
    }, IntPtr.Zero);
    return list;
  }

  public static List<WinInfo> Windows()
  {
    List<WinInfo> list = new List<WinInfo>();
    IntPtr foreground = GetForegroundWindow();
    EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
    {
      if (!IsWindowVisible(hWnd)) return true;
      RECT frame = new RECT();
      if (!GetWindowRect(hWnd, out frame)) return true;
      RECT visible = frame;
      try
      {
        RECT extended = new RECT();
        if (DwmGetWindowAttribute(hWnd, 9, out extended, Marshal.SizeOf(typeof(RECT))) == 0) visible = extended;
      }
      catch { }
      if (visible.Right - visible.Left < 32 || visible.Bottom - visible.Top < 32) return true;
      uint pid = 0;
      GetWindowThreadProcessId(hWnd, out pid);
      uint dpi = 96;
      try { dpi = GetDpiForWindow(hWnd); } catch { dpi = 96; }
      WinInfo item = new WinInfo();
      item.Hwnd = hWnd.ToInt64();
      item.Pid = pid;
      item.Minimized = IsIconic(hWnd);
      item.Focused = hWnd == foreground;
      item.Left = visible.Left;
      item.Top = visible.Top;
      item.Right = visible.Right;
      item.Bottom = visible.Bottom;
      item.FrameLeft = frame.Left;
      item.FrameTop = frame.Top;
      item.FrameRight = frame.Right;
      item.FrameBottom = frame.Bottom;
      item.Dpi = dpi;
      list.Add(item);
      return true;
    }, IntPtr.Zero);
    return list;
  }

  public static bool GetBounds(IntPtr hWnd, out RECT frame, out RECT visible)
  {
    frame = new RECT();
    visible = new RECT();
    if (!GetWindowRect(hWnd, out frame)) return false;
    visible = frame;
    try
    {
      RECT extended = new RECT();
      if (DwmGetWindowAttribute(hWnd, 9, out extended, Marshal.SizeOf(typeof(RECT))) == 0) visible = extended;
    }
    catch { }
    return true;
  }

  public static bool SetOuter(IntPtr hWnd, int x, int y, int width, int height)
  {
    return SetWindowPos(hWnd, IntPtr.Zero, x, y, width, height, 0x0014);
  }

  public static void Restore(IntPtr hWnd) { ShowWindow(hWnd, 9); }

  public static int LastError() { return Marshal.GetLastWin32Error(); }
}
'@
} catch {
  Reply @{ ok = $false; code = 'E_UNAVAILABLE'; reason = 'policy_blocked' }
  exit 0
}

$processDpi = $false
try { $processDpi = [StageWin32]::EnableDpi() } catch { $processDpi = $false }
if (-not $processDpi) {
  try { [StageWin32]::SetThreadDpiAwarenessContext([IntPtr](-4)) | Out-Null } catch { }
}
$dpiAware = $false
try {
  $dpiAware = [StageWin32]::AreDpiAwarenessContextsEqual([StageWin32]::GetThreadDpiAwarenessContext(), [IntPtr](-4))
} catch { $dpiAware = $processDpi }

function New-Rect($left, $top, $right, $bottom) {
  [pscustomobject]@{ x = [int]$left; y = [int]$top; w = [int]($right - $left); h = [int]($bottom - $top) }
}

try {
  switch ($request.op) {
    'displays' {
      $rows = @()
      foreach ($monitor in [StageWin32]::Monitors()) {
        $rows += [pscustomobject]@{
          bounds = New-Rect $monitor.Left $monitor.Top $monitor.Right $monitor.Bottom
          workArea = New-Rect $monitor.WorkLeft $monitor.WorkTop $monitor.WorkRight $monitor.WorkBottom
          dpi = $monitor.Dpi
          primary = $monitor.Primary
        }
      }
      Reply @{ ok = $true; dpiAware = $dpiAware; monitors = $rows }
    }
    'windows' {
      $rows = @()
      foreach ($window in [StageWin32]::Windows()) {
        $appName = ''
        try { $appName = (Get-Process -Id $window.Pid -ErrorAction Stop).ProcessName } catch { $appName = '' }
        if ($appName -eq 'ApplicationFrameHost') { continue }
        $rows += [pscustomobject]@{
          hwnd = [string]$window.Hwnd
          pid = $window.Pid
          app = $appName
          bounds = New-Rect $window.Left $window.Top $window.Right $window.Bottom
          frame = New-Rect $window.FrameLeft $window.FrameTop $window.FrameRight $window.FrameBottom
          inset = [pscustomobject]@{
            l = [int]($window.Left - $window.FrameLeft)
            t = [int]($window.Top - $window.FrameTop)
            r = [int]($window.FrameRight - $window.Right)
            b = [int]($window.FrameBottom - $window.Bottom)
          }
          dpi = $window.Dpi
          focused = $window.Focused
          minimized = $window.Minimized
        }
      }
      Reply @{ ok = $true; dpiAware = $dpiAware; windows = $rows }
    }
    'move' {
      $hwnd = [IntPtr]([long]$request.target.hwnd)
      if (-not [StageWin32]::IsWindow($hwnd)) { Reply @{ ok = $false; code = 'E_UNAVAILABLE'; reason = 'window_gone' }; break }
      if ([StageWin32]::IsIconic($hwnd)) { Reply @{ ok = $false; code = 'E_UNAVAILABLE'; reason = 'minimized' }; break }
      $frame = New-Object StageWin32+RECT
      $visible = New-Object StageWin32+RECT
      if (-not [StageWin32]::GetBounds($hwnd, [ref]$frame, [ref]$visible)) { Reply @{ ok = $false; code = 'E_UNAVAILABLE'; reason = 'window_gone' }; break }
      $before = New-Rect $visible.Left $visible.Top $visible.Right $visible.Bottom
      if ($null -ne $request.expect) {
        if ([Math]::Abs($visible.Left - [int]$request.expect.x) -gt 1 -or [Math]::Abs($visible.Top - [int]$request.expect.y) -gt 1 -or [Math]::Abs(($visible.Right - $visible.Left) - [int]$request.expect.w) -gt 1 -or [Math]::Abs(($visible.Bottom - $visible.Top) - [int]$request.expect.h) -gt 1) {
          Reply @{ ok = $false; code = 'E_UNAVAILABLE'; reason = 'stale_window' }
          break
        }
      }
      $target = $request.rect
      if ($null -ne $request.outer) {
        $outer = $request.outer
      } else {
        $left = $visible.Left - $frame.Left
        $top = $visible.Top - $frame.Top
        $right = $frame.Right - $visible.Right
        $bottom = $frame.Bottom - $visible.Bottom
        $outer = [pscustomobject]@{
          x = [int]$target.x - $left
          y = [int]$target.y - $top
          w = [int]$target.w + $left + $right
          h = [int]$target.h + $top + $bottom
        }
      }
      if (-not [StageWin32]::SetOuter($hwnd, [int]$outer.x, [int]$outer.y, [int]$outer.w, [int]$outer.h)) {
        $code = 'E_UNAVAILABLE'
        $reason = 'setwindowpos_failed'
        if ([StageWin32]::LastError() -eq 5) { $code = 'E_DENIED'; $reason = 'access_denied' }
        Reply @{ ok = $false; code = $code; reason = $reason; before = $before }
        break
      }
      $frame2 = New-Object StageWin32+RECT
      $visible2 = New-Object StageWin32+RECT
      [StageWin32]::GetBounds($hwnd, [ref]$frame2, [ref]$visible2) | Out-Null
      $after = New-Rect $visible2.Left $visible2.Top $visible2.Right $visible2.Bottom
      $verified = ([Math]::Abs($after.x - [int]$target.x) -le 1) -and ([Math]::Abs($after.y - [int]$target.y) -le 1) -and ([Math]::Abs($after.w - [int]$target.w) -le 1) -and ([Math]::Abs($after.h - [int]$target.h) -le 1)
      Reply @{ ok = $true; before = $before; after = $after; verified = $verified; dpiAware = $dpiAware }
    }
    'resize' {
      $hwnd = [IntPtr]([long]$request.target.hwnd)
      if (-not [StageWin32]::IsWindow($hwnd)) { Reply @{ ok = $false; code = 'E_UNAVAILABLE'; reason = 'window_gone' }; break }
      if ([StageWin32]::IsIconic($hwnd)) { Reply @{ ok = $false; code = 'E_UNAVAILABLE'; reason = 'minimized' }; break }
      $frame = New-Object StageWin32+RECT
      $visible = New-Object StageWin32+RECT
      if (-not [StageWin32]::GetBounds($hwnd, [ref]$frame, [ref]$visible)) { Reply @{ ok = $false; code = 'E_UNAVAILABLE'; reason = 'window_gone' }; break }
      $before = New-Rect $visible.Left $visible.Top $visible.Right $visible.Bottom
      if ($null -ne $request.expect) {
        if ([Math]::Abs($visible.Left - [int]$request.expect.x) -gt 1 -or [Math]::Abs($visible.Top - [int]$request.expect.y) -gt 1 -or [Math]::Abs(($visible.Right - $visible.Left) - [int]$request.expect.w) -gt 1 -or [Math]::Abs(($visible.Bottom - $visible.Top) - [int]$request.expect.h) -gt 1) {
          Reply @{ ok = $false; code = 'E_UNAVAILABLE'; reason = 'stale_window' }
          break
        }
      }
      $target = [pscustomobject]@{ x = $visible.Left; y = $visible.Top; w = [int]$request.size.w; h = [int]$request.size.h }
      if ($null -ne $request.outer) {
        $outer = $request.outer
      } else {
        $left = $visible.Left - $frame.Left
        $top = $visible.Top - $frame.Top
        $right = $frame.Right - $visible.Right
        $bottom = $frame.Bottom - $visible.Bottom
        $outer = [pscustomobject]@{ x = $frame.Left; y = $frame.Top; w = $target.w + $left + $right; h = $target.h + $top + $bottom }
      }
      if (-not [StageWin32]::SetOuter($hwnd, [int]$outer.x, [int]$outer.y, [int]$outer.w, [int]$outer.h)) {
        $code = 'E_UNAVAILABLE'
        $reason = 'setwindowpos_failed'
        if ([StageWin32]::LastError() -eq 5) { $code = 'E_DENIED'; $reason = 'access_denied' }
        Reply @{ ok = $false; code = $code; reason = $reason; before = $before }
        break
      }
      $frame2 = New-Object StageWin32+RECT
      $visible2 = New-Object StageWin32+RECT
      [StageWin32]::GetBounds($hwnd, [ref]$frame2, [ref]$visible2) | Out-Null
      $after = New-Rect $visible2.Left $visible2.Top $visible2.Right $visible2.Bottom
      $verified = ([Math]::Abs($after.w - [int]$target.w) -le 1) -and ([Math]::Abs($after.h - [int]$target.h) -le 1)
      Reply @{ ok = $true; before = $before; after = $after; verified = $verified; dpiAware = $dpiAware }
    }
    'restore' {
      $hwnd = [IntPtr]([long]$request.target.hwnd)
      [StageWin32]::Restore($hwnd) | Out-Null
      Reply @{ ok = $true }
    }
    'doctor' {
      Reply @{ ok = $true; platform = 'win32'; permission = 'none'; dpiAware = $dpiAware; warnings = @() }
    }
    default {
      Reply @{ ok = $false; code = 'E_UNAVAILABLE'; reason = 'unknown_op' }
    }
  }
} catch {
  Reply @{ ok = $false; code = 'E_UNAVAILABLE'; reason = 'powershell_error' }
}
`

const WIN_ID = /^win:(0x[0-9a-f]+|\d+)$/i

/** `available()` follows the host platform; the constructor can override it for tests. */
export const available = () => process.platform === 'win32'

/** Convert the outer frame and visible frame into positive border insets. */
export function compensate(rect, inset = {}) {
  const left = Number(inset.l) || 0
  const top = Number(inset.t) || 0
  const right = Number(inset.r) || 0
  const bottom = Number(inset.b) || 0
  return {
    x: Math.round(rect.x - left),
    y: Math.round(rect.y - top),
    w: Math.round(rect.w + left + right),
    h: Math.round(rect.h + top + bottom),
  }
}

export function parseWindowId(id) {
  const match = typeof id === 'string' ? WIN_ID.exec(id) : null
  if (match === null) return null
  try {
    return BigInt(match[1]).toString()
  } catch {
    return null
  }
}

function numberRect(value) {
  if (!isRect(value)) return null
  return { x: Number(value.x), y: Number(value.y), w: Number(value.w), h: Number(value.h) }
}

/** Parse EnumDisplayMonitors output into normalized display records. */
export function parseDisplays(payload) {
  expectOk(payload)
  const monitors = Array.isArray(payload?.monitors) ? payload.monitors : []
  if (monitors.length === 0) {
    throw new StageAdapterError('E_UNAVAILABLE', 'Windows reported no displays', { reason: 'no_displays' })
  }
  return monitors.map((monitor, index) => {
    const bounds = numberRect(monitor?.bounds)
    const workArea = numberRect(monitor?.workArea ?? monitor?.bounds)
    if (bounds === null || workArea === null) {
      throw new StageAdapterError('E_UNAVAILABLE', 'Windows returned an invalid monitor rect', { reason: 'bad_display' })
    }
    const dpi = Number(monitor.dpi) > 0 ? Number(monitor.dpi) : 96
    return {
      id: `win:display:${index}`, bounds, workArea, dpi, scale: dpi / 96,
      primary: Boolean(monitor.primary),
    }
  })
}

/** Parse enumerated top-level windows and attach display attribution. */
export function parseWindows(payload, displays) {
  expectOk(payload)
  const rows = Array.isArray(payload?.windows) ? payload.windows : []
  const windows = []
  for (const row of rows) {
    const hwnd = parseWindowId(row?.id ?? (row?.hwnd === undefined ? null : `win:${row.hwnd}`))
    const bounds = numberRect(row?.bounds)
    if (hwnd === null || bounds === null || row?.minimized || row.app === 'ApplicationFrameHost') continue
    const frame = numberRect(row?.frame) ?? bounds
    const inset = row.inset == null
      ? insetOf(frame, bounds)
      : {
          l: Number(row.inset.l) || 0, t: Number(row.inset.t) || 0,
          r: Number(row.inset.r) || 0, b: Number(row.inset.b) || 0,
        }
    const { displayId, spanning } = displayForRect(bounds, displays)
    windows.push({
      id: `win:${hwnd}`, pid: Number.isInteger(row.pid) ? row.pid : 0,
      displayId, bounds, frame, inset, dpi: Number(row.dpi) > 0 ? Number(row.dpi) : 96,
      focused: Boolean(row.focused), minimized: false, fullscreen: false,
      app: typeof row.app === 'string' ? row.app : '', spanning,
    })
  }
  let focused = false
  for (const window of windows) {
    if (window.focused && focused) window.focused = false
    if (window.focused) focused = true
  }
  return windows
}

export class WindowsAdapter {
  constructor(options = {}) {
    this.platform = 'win32'
    this._platform = options.platform ?? process.platform
    this._runner = resolveRunner(options)
    this._env = options.env
    this._windows = new Map()
  }

  available() {
    return this._platform === 'win32'
  }
  capabilities() {
    return {
      displays: true, windows: true, move: true, resize: true,
      focus: false, spaces: false, permission: 'same-integrity',
    }
  }
  _request(request) {
    return runAdapter({
      runner: this._runner,
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT],
      request,
      timeout: 8000,
      env: this._env,
    })
  }
  async displays() {
    return parseDisplays(this._request({ op: 'displays' }))
  }
  async windows(options = {}) {
    const displays = options.displays ?? await this.displays()
    const windows = parseWindows(this._request({ op: 'windows' }), displays)
    this._windows = new Map(windows.map(window => [window.id, window]))
    return windows
  }
  async move(id, rect) {
    const hwnd = parseWindowId(id)
    if (hwnd === null) return { ok: false, id, code: 'E_DENIED', reason: 'invalid_id' }
    let bounds
    try {
      bounds = asRect(rect, 'E_DENIED')
    } catch (error) {
      return { ok: false, id, code: error.code, reason: error.reason }
    }
    const row = this._windows.get(id)
    if (row === undefined) return { ok: false, id, code: 'E_DENIED', reason: 'unobserved_window' }
    const request = { op: 'move', target: { hwnd }, rect: bounds }
    request.outer = compensate(bounds, row.inset)
    request.expect = row.bounds
    const payload = this._request(request)
    if (payload?.ok === false) {
      return { ok: false, id, code: payload.code === 'E_DENIED' ? 'E_DENIED' : 'E_UNAVAILABLE', reason: payload.reason }
    }
    const before = numberRect(payload?.before)
    const after = numberRect(payload?.after)
    const verified = sameRect(after, bounds, 1)
    if (verified && row !== undefined) {
      this._windows.set(id, { ...row, bounds: after, frame: request.outer })
    }
    return {
      ok: verified, id, before, after, verified,
      ...(verified ? {} : { code: 'E_UNAVAILABLE', reason: 'verify_mismatch' }),
    }
  }
  async resize(id, size) {
    const hwnd = parseWindowId(id)
    if (hwnd === null) return { ok: false, id, code: 'E_DENIED', reason: 'invalid_id' }
    if (!Number.isFinite(size?.w) || !Number.isFinite(size?.h) || size.w <= 0 || size.h <= 0) {
      return { ok: false, id, code: 'E_DENIED', reason: 'invalid_size' }
    }
    const row = this._windows.get(id)
    if (row === undefined) return { ok: false, id, code: 'E_DENIED', reason: 'unobserved_window' }
    const request = { op: 'resize', target: { hwnd }, size: { w: size.w, h: size.h } }
    request.outer = {
      x: Math.round(row.frame.x), y: Math.round(row.frame.y),
      w: Math.round(size.w + row.inset.l + row.inset.r),
      h: Math.round(size.h + row.inset.t + row.inset.b),
    }
    request.expect = row.bounds
    const payload = this._request(request)
    if (payload?.ok === false) {
      return { ok: false, id, code: payload.code === 'E_DENIED' ? 'E_DENIED' : 'E_UNAVAILABLE', reason: payload.reason }
    }
    const before = numberRect(payload?.before)
    const after = numberRect(payload?.after)
    const verified = sameSize(after, size, 1)
    if (verified && row !== undefined) {
      this._windows.set(id, { ...row, bounds: after, frame: request.outer })
    }
    return {
      ok: verified, id, before, after, verified,
      ...(verified ? {} : { code: 'E_UNAVAILABLE', reason: 'verify_mismatch' }),
    }
  }

  async focus() {
    return { ok: false, code: 'E_UNAVAILABLE', reason: 'unsupported' }
  }

  async spaces() {
    return []
  }

  async doctor() {
    const payload = expectOk(this._request({ op: 'doctor' }))
    return {
      ok: Boolean(payload?.ok), platform: 'win32', permission: 'none',
      dpiAware: Boolean(payload?.dpiAware), warnings: Array.isArray(payload?.warnings) ? payload.warnings : [],
    }
  }
}
