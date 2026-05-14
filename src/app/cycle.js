// Helpers for cycling through model ids / thinking levels. Used by RPC mode
// (cycle_model / cycle_thinking_level) and earmarked for the future Ctrl+P
// keybind in the TUI.

import { MODEL_REGISTRY, modelEntryMatches, modelRef, modelRefMatches } from "./models.js"

/** @typedef {import("./settings.js").Settings} Settings */
/** @typedef {import("./models.js").ModelEntry} ModelEntry */

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"]

/** @typedef {"off" | "minimal" | "low" | "medium" | "high"} ThinkingLevel */

/**
 * Return the next model id after `currentId` from the scoped subset, wrapping
 * around. Falls back to the full registry when `scopedIds` is empty so the
 * cycle is always meaningful. Returns null if the registry is empty (defensive).
 *
 * Also reports `isScoped` so callers can surface "cycling within X scoped
 * models" vs. the full list.
 *
 * @param {string} currentId
 * @param {string[]} scopedIds
 * @param {ModelEntry[]} [models]
 * @returns {{ id: string, isScoped: boolean } | null}
 */
export function cycleModelId(currentId, scopedIds, models = MODEL_REGISTRY) {
	const scoped = scopedIds.length > 0
		? models.filter((m) => scopedIds.some((id) => modelRefMatches(m, id)))
		: models
	if (scoped.length === 0) return null
	const idx = scoped.findIndex((m) => modelEntryMatches(m, currentId))
	const next = scoped[(idx + 1) % scoped.length]
	return { id: modelRef(next), isScoped: scopedIds.length > 0 }
}

/**
 * Cycle through the five thinking levels in fixed order.
 * @param {ThinkingLevel} current
 * @returns {ThinkingLevel}
 */
export function cycleThinkingLevel(current) {
	const idx = THINKING_LEVELS.indexOf(current)
	return /** @type {ThinkingLevel} */ (THINKING_LEVELS[(idx + 1) % THINKING_LEVELS.length])
}

/**
 * Convenience wrapper used by RPC handlers — pulls scopedModelIds from settings.
 * @param {string} currentId
 * @param {Pick<Settings, "scopedModelIds">} settings
 */
export function cycleModelIdForSettings(currentId, settings) {
	return cycleModelId(currentId, settings.scopedModelIds)
}
