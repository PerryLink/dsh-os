# Changelog

## 0.1.0

- Add `NotifyService` at `ctx.notify`: `registerChannel`, `channels`, `send`,
  `history` and `clear`.
- Route notifications to caller-registered channel adapters and record every
  attempt as `{ id, channel, ok, error, at }`. Unknown channels reject with
  `E_UNAVAILABLE`; adapter failures are recorded with `ok: false`.
- Suppress repeat deliveries by `dedupeKey` inside a configurable window
  (default 5 minutes, process-local).
- Add plain tool definitions `notify_send`, `notify_channels` and
  `notify_history`.
- No real IM, desktop or phone channel is implemented; those adapters land in
  0.2.0. Ring can use the service for escalation notifications once a channel
  is registered.
