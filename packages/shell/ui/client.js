/**
 * dsh-os-shell React client bundle — a classic script, built by hand.
 *
 * DSH serves this file as-is: the module loader calls `factory(require)` and
 * React comes from the host module table. There is no JSX, no bundler and no
 * React dependency in package.json. The page is the root `main` key `os`; the
 * sidebar icon registers into `sidebar.panellist` with the same id.
 * @module @perrylink/dsh-os-shell/client
 */
window.__ModuleLoader__.load({
  id: '@perrylink/dsh-os-shell',
  factory: function (require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect } = React
    const TABS = [
      ['approvals', 'Approvals'], ['activity', 'Activity'],
      ['act', 'Act'], ['snip', 'Snip'], ['check', 'Check'],
    ]
    const CSS = `
.os-shell{padding:20px;overflow:auto;height:100%;box-sizing:border-box;color:var(--dsw-alias-label-primary)}
.os-shell-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.os-shell h1{margin:0 0 4px;font-size:18px}
.os-shell-muted{margin:4px 0;color:var(--dsw-alias-label-tertiary);font-size:13px}
.os-shell-tabs{display:flex;gap:4px;margin:16px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.os-shell-tab{border:0;background:transparent;padding:8px 12px;cursor:pointer;color:var(--dsw-alias-label-secondary)}
.os-shell-tab-active{border-bottom:2px solid var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}
.os-shell-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.os-shell-card{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px 12px;margin:8px 0;background:var(--dsw-alias-bg-layer-1)}
.os-shell button{border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:4px 10px;cursor:pointer;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.os-shell input{flex:1 1 220px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:6px 8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.os-shell textarea{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:8px;font-family:ui-monospace,monospace;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.os-shell code{font-family:ui-monospace,monospace;font-size:12px;color:var(--dsw-alias-label-secondary)}
.os-shell-badge{border:1px solid currentColor;border-radius:999px;padding:1px 8px;font-size:11px;text-transform:uppercase}
.os-shell-pre{overflow:auto;padding:10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:12px}
.os-shell-pre-error{color:var(--dsw-alias-label-error)}
.os-shell-error{padding:10px;border-radius:8px;border:1px solid var(--dsw-alias-label-error);color:var(--dsw-alias-label-error);white-space:pre-wrap}
.os-shell-notice{color:var(--dsw-alias-state-success-primary);font-size:12px}
.os-shell-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
.os-shell-label{color:var(--dsw-alias-label-tertiary);font-size:12px;white-space:nowrap}
`
    function errorText(error) {
      if (!error) return 'Unknown error'
      return (error.code ? error.code + ': ' : '') + (error.message || String(error))
    }
    function pretty(value) {
      try { return JSON.stringify(value, null, 2) } catch { return String(value) }
    }
    async function request(path, options) {
      let response; try { response = await fetch(path, options) } catch (error) { throw new Error('Network error: ' + errorText(error)) }
      let data = null; try { data = await response.json() } catch { data = null }
      if (!response.ok) {
        const failure = new Error((data && data.message) || response.statusText || 'Request failed')
        failure.code = (data && data.code) || 'http_' + response.status
        throw failure
      }
      if (data === null) throw new Error('Response from ' + path + ' was not JSON')
      return data
    }
    const badge = (text, color) => h('span', { className: 'os-shell-badge', style: { color } }, text)
    const verdictBadge = verdict => badge(String(verdict || 'unknown'), verdict === 'regression'
      ? 'var(--dsw-alias-label-error)' : verdict === 'warning' ? 'var(--dsw-alias-state-warn-label)'
        : 'var(--dsw-alias-state-success-primary)')
    function timeText(value) {
      const ms = typeof value === 'number' ? value
        : typeof value === 'string' && value.trim() !== '' ? Date.parse(value) : NaN
      if (!Number.isFinite(ms)) return typeof value === 'string' && value !== '' ? value : '—'
      const date = new Date(ms > 0 && ms < 1e12 ? ms * 1000 : ms)
      try { return date.toLocaleString() } catch { return date.toISOString() }
    }
    function scopeText(value) {
      if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : '—'
      return typeof value === 'string' && value !== '' ? value : '—'
    }
    function riskColor(risk) {
      return risk === 'danger' ? 'var(--dsw-alias-label-error)'
        : risk === 'write' ? 'var(--dsw-alias-state-warn-label)'
          : risk === 'read' ? 'var(--dsw-alias-state-success-primary)'
            : 'var(--dsw-alias-label-secondary)'
    }
    function ActTab(props) {
      const [query, setQuery] = useState(''); const [args, setArgs] = useState('{}')
      const [result, setResult] = useState(null)
      const [busy, setBusy] = useState('')
      const section = props.section
      const actions = section && section.available && Array.isArray(section.actions) ? section.actions : []
      const needle = query.trim().toLowerCase()
      const shown = needle === '' ? actions : actions.filter(action =>
        (action.id + ' ' + action.title + ' ' + (action.description || '')).toLowerCase().includes(needle))
      async function run(action) {
        setResult(null)
        let parsed
        try { parsed = args.trim() === '' ? {} : JSON.parse(args) } catch {
          setResult({ ok: false, code: 'invalid_arguments', message: 'Arguments are not valid JSON.' })
          return
        }
        if (action.risk !== 'read'
          && !window.confirm('Run ' + action.risk + ' action "' + action.title + '"? It may change state.')) return
        setBusy(action.id)
        try {
          setResult(await request('api/os-shell/act/invoke', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: action.id, args: parsed }),
          }))
        } catch (error) {
          setResult({ ok: false, code: error.code || 'request_failed', message: errorText(error) })
        } finally { setBusy('') }
      }
      return h('div', null,
        h('div', { className: 'os-shell-row' },
          h('input', {
            placeholder: 'Filter actions by id, title or description',
            value: query,
            onChange: event => setQuery(event.target.value),
          }),
          h('button', { onClick: props.onRefresh }, 'Refresh')),
        props.error ? h('p', { className: 'os-shell-error' }, props.error) : null,
        !section ? h('p', { className: 'os-shell-muted' }, props.loading ? 'Loading…' : 'No snapshot yet.')
          : !section.available ? h('p', { className: 'os-shell-muted' }, 'Act is not installed in this profile.')
            : shown.length === 0 ? h('p', { className: 'os-shell-muted' }, 'No actions match.')
              : shown.map(action => h('div', { key: action.id, className: 'os-shell-card' },
                h('div', { className: 'os-shell-row' },
                  h('strong', null, action.title),
                  h('code', null, action.id),
                  badge(action.risk, 'var(--dsw-alias-label-secondary)'),
                  h('button', { disabled: busy === action.id, onClick: () => run(action) },
                    busy === action.id ? 'Running…' : 'Run')),
                action.description ? h('p', { className: 'os-shell-muted' }, action.description) : null)),
        h('label', { className: 'os-shell-muted', style: { display: 'block', marginTop: '12px' } },
          'Arguments (JSON, shared by every run on this tab)'),
        h('textarea', { rows: 4, value: args, onChange: event => setArgs(event.target.value) }),
        result ? h('pre', {
          className: 'os-shell-pre' + (result.ok === false ? ' os-shell-pre-error' : ''),
        }, pretty(result)) : null)
    }
    function ApprovalsTab() {
      const [items, setItems] = useState(null)
      const [by, setBy] = useState('')
      const [reason, setReason] = useState('')
      const [scope, setScope] = useState('')
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState('')
      const [loading, setLoading] = useState(true)
      async function load() {
        setLoading(true)
        setError('')
        try {
          const data = await request('api/os-approvals?status=pending')
          setItems(Array.isArray(data.items) ? data.items : [])
        } catch (failure) {
          setError(failure.code === 'service_unavailable'
            ? 'Allow is not installed in this profile.' : errorText(failure))
          setItems(null)
        } finally { setLoading(false) }
      }
      async function decide(item, decision) {
        setError('')
        setNotice('')
        const approver = by.trim()
        if (approver === '') {
          setError('Approver is required: enter the human deciding this request.')
          return
        }
        if (/^(agent|session|tool|plugin|ui):/i.test(approver)) {
          setError('Agent, session, tool, plugin and ui identities cannot decide.')
          return
        }
        if (decision === 'deny' && reason.trim() === '') {
          setError('A deny reason is required.')
          return
        }
        if (decision === 'approve' && item.risk === 'danger'
          && !window.confirm('Approve danger request "' + item.id + '"? It may be irreversible.')) return
        if (decision === 'deny' && !window.confirm('Deny request "' + item.id + '"?')) return
        const body = { by: approver }
        if (decision === 'approve' && scope.trim() !== '') body.scope = scope.trim()
        if (decision === 'deny' && reason.trim() !== '') body.reason = reason.trim()
        setBusy(item.id + ':' + decision)
        try {
          await request('api/os-approvals/' + encodeURIComponent(item.id) + '/' + decision, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
          setItems(rows => (rows || []).filter(row => row.id !== item.id))
          setNotice((decision === 'approve' ? 'Approved ' : 'Denied ') + item.id)
        } catch (failure) {
          setError(errorText(failure))
        } finally { setBusy('') }
      }
      useEffect(() => { load() }, [])
      const disabled = busy !== '' || by.trim() === ''
      return h('div', null,
        h('div', { className: 'os-shell-row' },
          h('label', { className: 'os-shell-label' }, 'Approver (required)'),
          h('input', {
            placeholder: 'your name or os-user',
            value: by,
            onChange: event => setBy(event.target.value),
          }),
          h('button', { onClick: load, disabled: loading }, loading ? 'Loading…' : 'Refresh')),
        h('p', { className: 'os-shell-muted' },
          'Decisions are human-only. Nothing is approved automatically; agent identities are rejected.'),
        h('div', { className: 'os-shell-row' },
          h('label', { className: 'os-shell-label' }, 'Scope override (optional, can only narrow)'),
          h('input', {
            placeholder: 'e.g. repo:/work/file',
            value: scope,
            onChange: event => setScope(event.target.value),
          }),
          h('label', { className: 'os-shell-label' }, 'Deny reason (required)'),
          h('input', {
            placeholder: 'optional',
            value: reason,
            onChange: event => setReason(event.target.value),
          })),
        error ? h('p', { className: 'os-shell-error' }, error) : null,
        notice ? h('p', { className: 'os-shell-notice' }, notice) : null,
        !items && loading ? h('p', { className: 'os-shell-muted' }, 'Loading…') : null,
        items && items.length === 0
          ? h('p', { className: 'os-shell-muted' }, 'No pending approval requests.') : null,
        (items || []).map(item => h('div', { key: item.id, className: 'os-shell-card' },
          h('div', { className: 'os-shell-row' },
            badge(item.risk || 'unknown', riskColor(item.risk)),
            h('strong', null, item.capability || 'unknown capability'),
            h('code', null, item.id || '')),
          h('p', { className: 'os-shell-muted' }, 'Requester: ' + (item.subject || '—')),
          h('p', { className: 'os-shell-muted' }, 'Scope: ' + scopeText(item.scope)),
          item.reason ? h('p', { className: 'os-shell-muted' }, 'Reason: ' + item.reason) : null,
          h('p', { className: 'os-shell-muted' },
            'Created: ' + timeText(item.createdAt) + ' · Expires: ' + timeText(item.expiresAt)),
          h('div', { className: 'os-shell-actions' },
            h('button', {
              disabled,
              onClick: () => decide(item, 'approve'),
            }, busy === item.id + ':approve' ? 'Approving…' : 'Approve'),
            h('button', {
              disabled,
              onClick: () => decide(item, 'deny'),
            }, busy === item.id + ':deny' ? 'Denying…' : 'Deny')))))
    }
    function ActivityTab() {
      const [entries, setEntries] = useState(null)
      const [sources, setSources] = useState(null)
      const [error, setError] = useState('')
      const [loading, setLoading] = useState(true)
      async function load() {
        setLoading(true)
        setError('')
        try {
          const data = await request('api/os-activity?limit=50')
          setEntries(Array.isArray(data.entries) ? data.entries : [])
          setSources(data.sources || null)
        } catch (failure) {
          setError(errorText(failure))
          setEntries(null)
          setSources(null)
        } finally { setLoading(false) }
      }
      useEffect(() => { load() }, [])
      return h('div', null,
        h('div', { className: 'os-shell-row' },
          h('strong', null, 'Recent approvals and actions'),
          h('button', { onClick: load, disabled: loading }, loading ? 'Loading…' : 'Refresh')),
        h('p', { className: 'os-shell-muted' },
          'Newest first. Rows come from Allow audit and Act audit/list when those services exist.'),
        error ? h('p', { className: 'os-shell-error' }, error) : null,
        !entries && loading ? h('p', { className: 'os-shell-muted' }, 'Loading…') : null,
        entries && entries.length === 0
          ? h('p', { className: 'os-shell-muted' },
            sources && !sources.approvals && !sources.actions
              ? 'Allow and Act are not installed in this profile.' : 'No activity yet.') : null,
        (entries || []).map((entry, index) => h('div', {
          key: entry.kind + ':' + (entry.id || index), className: 'os-shell-card',
        },
        h('div', { className: 'os-shell-row' },
          badge(entry.kind, entry.kind === 'approval'
            ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)'),
          h('strong', null, entry.title || entry.event || entry.id || 'entry'),
          entry.risk ? badge(entry.risk, riskColor(entry.risk)) : null,
          h('span', { className: 'os-shell-muted' }, timeText(entry.at))),
        entry.subject ? h('p', { className: 'os-shell-muted' }, 'Subject: ' + entry.subject) : null,
        entry.capability ? h('p', { className: 'os-shell-muted' },
          'Capability: ' + entry.capability) : null,
        entry.scope ? h('p', { className: 'os-shell-muted' }, 'Scope: ' + scopeText(entry.scope)) : null,
        entry.status || entry.reason ? h('p', { className: 'os-shell-muted' },
          [entry.status, entry.reason].filter(Boolean).join(' · ')) : null)))
    }
    function SnipTab() {
      const [query, setQuery] = useState('')
      const [entries, setEntries] = useState(null)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [loading, setLoading] = useState(true)
      async function load(term) {
        setLoading(true)
        setError('')
        try {
          const data = await request('api/os-shell/snip/search?q=' + encodeURIComponent(term || ''))
          setEntries(Array.isArray(data.entries) ? data.entries : [])
        } catch (failure) {
          setError(errorText(failure))
          setEntries(null)
        } finally { setLoading(false) }
      }
      async function copy(entry) {
        const text = typeof entry.text === 'string' ? entry.text : entry.preview
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text)
          else {
            const area = document.createElement('textarea')
            area.value = text
            document.body.appendChild(area)
            area.select()
            document.execCommand('copy')
            area.remove()
          }
          setNotice(entry.redacted ? 'Copied the redaction placeholder.' : 'Copied.')
        } catch (failure) { setNotice('Copy failed: ' + errorText(failure)) }
      }
      useEffect(() => { load('') }, [])
      return h('div', null,
        h('form', { className: 'os-shell-row', onSubmit: event => { event.preventDefault(); load(query) } },
          h('input', {
            placeholder: 'Search snippets (empty lists the newest 50)',
            value: query,
            onChange: event => setQuery(event.target.value),
          }),
          h('button', { type: 'submit' }, 'Search'),
          h('button', { type: 'button', onClick: () => { setQuery(''); load('') } }, 'Clear')),
        notice ? h('p', { className: 'os-shell-notice' }, notice) : null,
        error ? h('p', { className: 'os-shell-error' }, error) : null,
        loading && entries === null ? h('p', { className: 'os-shell-muted' }, 'Loading…') : null,
        entries && entries.length === 0 ? h('p', { className: 'os-shell-muted' }, 'No snippets match.') : null,
        (entries || []).map(entry => h('div', { key: entry.id, className: 'os-shell-card' },
          h('div', { className: 'os-shell-row' },
            h('code', null, entry.kind),
            entry.redacted ? badge('redacted', 'var(--dsw-alias-state-warn-label)') : null,
            h('span', { className: 'os-shell-muted' }, entry.createdAt || ''),
            h('button', { onClick: () => copy(entry) }, 'Copy')),
          h('p', { className: 'os-shell-muted' }, entry.preview || ''))))
    }
    function CheckTab() {
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [loading, setLoading] = useState(true)
      async function load() {
        setLoading(true)
        setError('')
        try { setData(await request('api/os-shell/check/last')) } catch (failure) {
          setError(errorText(failure))
          setData(null)
        } finally { setLoading(false) }
      }
      useEffect(() => { load() }, [])
      const last = data && data.last
      return h('div', null,
        h('div', { className: 'os-shell-row' },
          h('strong', null, 'Last Check comparison'),
          h('button', { onClick: load, disabled: loading }, loading ? 'Loading…' : 'Refresh')),
        error ? h('p', { className: 'os-shell-error' }, error) : null,
        !data && loading ? h('p', { className: 'os-shell-muted' }, 'Loading…') : null,
        data && !data.available ? h('p', { className: 'os-shell-muted' },
          'Check is not installed in this profile.') : null,
        data && data.available && !last ? h('p', { className: 'os-shell-muted' },
          'No last report is available (this Check build may keep no history).') : null,
        last ? h('div', null,
          h('div', { className: 'os-shell-row' },
            verdictBadge(last.verdict),
            h('code', null, 'exit ' + String(data.exitCode === null ? '—' : data.exitCode))),
          last.summary ? h('p', { className: 'os-shell-muted' },
            'tasks ' + String(last.summary.tasks) + ' · compared ' + String(last.summary.compared)
            + ' · regressions ' + String(last.summary.regressions)
            + ' · warnings ' + String(last.summary.warnings)) : null,
          (Array.isArray(last.tasks) ? last.tasks : []).map(task => h('div', {
            key: task.id, className: 'os-shell-card',
          },
          h('div', { className: 'os-shell-row' }, h('strong', null, task.id), verdictBadge(task.verdict)),
          (Array.isArray(task.diffs) ? task.diffs : []).map((diff, index) => h('p', {
            key: index, className: 'os-shell-muted',
          }, String(diff.severity || 'diff') + ': ' + String(diff.message || diff.dimension || ''))))),
          h('pre', { className: 'os-shell-pre' }, pretty(last))) : null)
    }
    function Page() {
      const [tab, setTab] = useState('approvals')
      const [snapshot, setSnapshot] = useState(null)
      const [error, setError] = useState('')
      const [loading, setLoading] = useState(true)
      const [nonce, setNonce] = useState(0)
      useEffect(() => {
        let live = true
        setLoading(true)
        setError('')
        request('api/os-shell/snapshot').then(data => {
          if (live) setSnapshot(data.snapshot)
        }, failure => {
          if (live) setError(errorText(failure))
        }).then(() => { if (live) setLoading(false) })
        return () => { live = false }
      }, [nonce])
      return h('div', { className: 'os-shell' },
        h('style', null, CSS),
        h('div', { className: 'os-shell-head' },
          h('div', null,
            h('h1', null, 'OS Shell'),
            h('p', { className: 'os-shell-muted' }, 'Optional control surface for approvals, activity, Act, Snip and Check.')),
          h('button', { onClick: () => setNonce(value => value + 1), disabled: loading },
            loading ? 'Loading…' : 'Refresh')),
        h('nav', { className: 'os-shell-tabs' }, TABS.map(([id, label]) => h('button', {
          key: id,
          className: 'os-shell-tab' + (tab === id ? ' os-shell-tab-active' : ''),
          onClick: () => setTab(id),
        }, label))),
        tab === 'approvals' ? h(ApprovalsTab)
          : tab === 'activity' ? h(ActivityTab)
            : tab === 'act'
              ? h(ActTab, {
                section: snapshot ? snapshot.act : null,
                loading,
                error,
                onRefresh: () => setNonce(value => value + 1),
              })
              : tab === 'snip' ? h(SnipTab) : h(CheckTab))
    }
    function Icon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 18
      return h('span', {
        'aria-hidden': true,
        style: {
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: size, height: size, borderRadius: '6px',
          border: '1px solid var(--dsw-alias-border-l2)',
          fontSize: Math.max(9, Math.round(size * 0.5)), fontWeight: 600,
          color: props && props.active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)',
        },
      }, 'OS')
    }
    function apply(ctx) {
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'os' }, Page))
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: 'os', order: 30, label: 'OS',
      }, Icon))
    }
    return { apply, inject: ['slots'] }
  },
})
