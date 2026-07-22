export const TERMINAL_FOCUS_IN_SEQUENCE = "\x1b[I"
export const TERMINAL_FOCUS_OUT_SEQUENCE = "\x1b[O"
export const TERMINAL_FOCUS_REPORTING_ENABLE_SEQUENCE = "\x1b[?1004h"
export const TERMINAL_FOCUS_REPORTING_DISABLE_SEQUENCE = "\x1b[?1004l"

/** @param {string} data @returns {boolean | undefined} */
export function terminalFocusPresence(data) {
	if (data === TERMINAL_FOCUS_IN_SEQUENCE) return true
	if (data === TERMINAL_FOCUS_OUT_SEQUENCE) return false
	return undefined
}
