// Shared reasoning-effort vocabulary and legacy normalization.

export const REASONING_LEVELS = /** @type {const} */ (["default", "none", "minimal", "low", "medium", "high", "xhigh"])

/** @typedef {typeof REASONING_LEVELS[number]} ReasoningLevel */
/** @typedef {ReasoningLevel | "off"} LegacyReasoningLevel */

const REASONING_LEVEL_SET = new Set(REASONING_LEVELS)

/**
 * `off` used to mean "omit reasoning_effort", which silently selected the
 * provider default. For GPT-5.5 that is medium, so preserve the user-facing
 * meaning instead: off == none.
 * @param {unknown} value
 * @returns {ReasoningLevel | undefined}
 */
export function normalizeReasoningLevel(value) {
	if (value === "off") return "none"
	return typeof value === "string" && REASONING_LEVEL_SET.has(value) ? /** @type {ReasoningLevel} */ (value) : undefined
}

/** @param {unknown} value */
export function isReasoningLevel(value) {
	return normalizeReasoningLevel(value) !== undefined
}

/**
 * Convert a stored/UI reasoning level to the OpenAI API field. `default` means
 * "omit the field and let the provider/model choose"; all other levels are
 * passed through verbatim.
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
