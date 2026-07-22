// Shared reasoning-effort vocabulary and normalization.

export const REASONING_LEVELS = /** @type {const} */ (["default", "none", "minimal", "low", "medium", "high", "xhigh", "max"])

/** @typedef {typeof REASONING_LEVELS[number]} ReasoningLevel */

const REASONING_LEVEL_SET = new Set(REASONING_LEVELS)

/** @param {unknown} value @returns {ReasoningLevel | undefined} */
export function normalizeReasoningLevel(value) {
	return typeof value === "string" && REASONING_LEVEL_SET.has(value) ? /** @type {ReasoningLevel} */ (value) : undefined
}

/** @param {unknown} value */
export function isReasoningLevel(value) {
	return normalizeReasoningLevel(value) !== undefined
}

/**
 * Convert a stored/UI reasoning level to the OpenAI API field. `default` means
 * "no explicit user override"; callers may then apply model metadata or omit
 * the field to let the provider choose. All other levels are passed through
 * verbatim.
 * @param {unknown} value
 * @returns {Exclude<ReasoningLevel, "default"> | undefined}
 */
export function reasoningEffortForApi(value) {
	const level = normalizeReasoningLevel(value)
	if (!level || level === "default") return undefined
	return /** @type {Exclude<ReasoningLevel, "default">} */ (level)
}

/** @param {unknown} value */
export function reasoningLevelLabel(value) {
	return normalizeReasoningLevel(value) ?? "default"
}
