// Helpers for cycling through model ids / reasoning levels. Earmarked for the
// future Ctrl+P keybind in the TUI.

import { REASONING_LEVELS, normalizeReasoningLevel } from "../reasoning.js"
import { MODEL_REGISTRY, modelRef, modelRefMatches } from "./models.js"

/** @typedef {import("./models.js").ModelEntry} ModelEntry */

export const THINKING_LEVELS = REASONING_LEVELS

/** @typedef {import("../reasoning.js").ReasoningLevel} ThinkingLevel */

/**
 * Return the next model id after `currentId`, wrapping around.
 * @param {string} currentId
 * @param {ModelEntry[]} [models]
 * @returns {{ id: string } | null}
 */
export function cycleModelId(currentId, models = MODEL_REGISTRY) {
	if (models.length === 0) return null
	const idx = models.findIndex((m) => modelRefMatches(m, currentId))
	const next = models[(idx + 1) % models.length]
	return { id: modelRef(next) }
}

/**
 * Cycle through reasoning levels in fixed order.
 * @param {ThinkingLevel} current
 * @returns {ThinkingLevel}
 */
export function cycleThinkingLevel(current) {
	const normalized = normalizeReasoningLevel(current) ?? "default"
	const idx = THINKING_LEVELS.indexOf(normalized)
	return /** @type {ThinkingLevel} */ (THINKING_LEVELS[(idx + 1) % THINKING_LEVELS.length])
}
