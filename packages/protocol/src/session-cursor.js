/**
 * Session sequence and view-epoch counters are ordered only within one cursor generation. A generation changes whenever the service-owned in-memory event state is recreated.
 * @param {any} value
 * @returns {string | undefined}
 */
export function sessionCursorGeneration(value) {
	return typeof value?.cursorGeneration === "string" && value.cursorGeneration
		? value.cursorGeneration
		: undefined
}

/**
 * @param {any} current
 * @param {any} next
 */
export function sessionCursorGenerationChanged(current, next) {
	return sessionCursorGeneration(current) !== sessionCursorGeneration(next)
}
