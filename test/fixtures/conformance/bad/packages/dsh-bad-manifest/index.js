export function apply(ctx) {
  console.log('fixture: console.log is not allowed in runtime code')
  ctx.provide('act', {})
}
