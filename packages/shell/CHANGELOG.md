# Changelog

## 0.1.0

- Add the optional Host seam `ctx.osShell`: `registerView`, `unregisterView`,
  `listViews`, `open`, `close`, plus the last-50 open `history`.
- Add a framework-free HTML `render()` with escaping.
- Add the lazy client entry `ui/index.js` exporting an empty `views` list.
- Register the plain-object tools `os_shell_views`, `os_shell_open` and
  `os_shell_close`.
- Validate ids (`^[a-z][a-z0-9_.-]+$`), title length, module names and mounts.
- Document that the shell is optional and does not implement eleven Apps.
