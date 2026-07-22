/** @param {any} message @param {boolean} hasToolCalls */
export function assistantErrorMessageForDisplay(message, hasToolCalls) {
	if (message?.role !== "assistant" || message?.compaction || hasToolCalls || message?.stopReason !== "error") return undefined
	return message.errorMessage ?? "Unknown error"
}

/** @param {any} message @param {boolean} hasToolCalls */
export function assistantInlineErrorTextForDisplay(message, hasToolCalls) {
	const errorMessage = assistantErrorMessageForDisplay(message, hasToolCalls)
	return errorMessage === undefined ? undefined : `Error: ${errorMessage}`
}
