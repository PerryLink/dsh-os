/**
 * dsh-os-shell client entry (lazy).
 *
 * The Host entry never imports this file. A client adapter may import it only
 * when the shell is actually shown, then resolve each `views` entry against the
 * Host registry. Today the shell ships no module UIs, so this list is empty.
 * @module dsh-os-shell/ui
 */

/** @type {Array<{ id: string, title: string, mount?: Function }>} */
export const views = []
