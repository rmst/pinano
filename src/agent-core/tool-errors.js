/**
 * Errors with this marker mean a tool call started but the harness lost track
 * of its outcome. The agent loop must not turn them into ordinary tool-result
 * errors, because retrying or assuming failure can be unsafe for effectful tools.
 */
export function isUncertainToolExecutionError(error) {
	return Boolean(error && typeof error === "object" && error.toolExecutionUncertain === true)
}

/** @param {Error} error */
export function markUncertainToolExecution(error) {
	error.toolExecutionUncertain = true
	return error
}
