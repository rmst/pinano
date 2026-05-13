// Helpers for cycling through model ids / thinking levels. Used by RPC mode
// (cycle_model / cycle_thinking_level) and earmarked for the future Ctrl+P
// keybind in the TUI.

import type { Settings } from "./settings.ts"
import type { ModelEntry } from "./models.ts"
import { MODEL_REGISTRY, modelEntryMatches, modelRef, modelRefMatches } from "./models.ts"

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"] as const
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

/**
 * Return the next model id after `currentId` from the scoped subset, wrapping
 * around. Falls back to the full registry when `scopedIds` is empty so the
 * cycle is always meaningful. Returns null if the registry is empty (defensive).
 *
 * Also reports `isScoped` so callers can surface "cycling within X scoped
 * models" vs. the full list.
 */
export function cycleModelId(
	currentId: string,
	scopedIds: string[],
	models: ModelEntry[] = MODEL_REGISTRY,
): { id: string; isScoped: boolean } | null {
	const scoped = scopedIds.length > 0
		? models.filter((m) => scopedIds.some((id) => modelRefMatches(m, id)))
		: models
	if (scoped.length === 0) return null
	const idx = scoped.findIndex((m) => modelEntryMatches(m, currentId))
	const next = scoped[(idx + 1) % scoped.length]!
	return { id: modelRef(next), isScoped: scopedIds.length > 0 }
}

/** Cycle through the five thinking levels in fixed order. */
export function cycleThinkingLevel(current: ThinkingLevel): ThinkingLevel {
	const idx = THINKING_LEVELS.indexOf(current)
	return THINKING_LEVELS[(idx + 1) % THINKING_LEVELS.length]!
}

/** Convenience wrapper used by RPC handlers — pulls scopedModelIds from settings. */
export function cycleModelIdForSettings(currentId: string, settings: Pick<Settings, "scopedModelIds">) {
	return cycleModelId(currentId, settings.scopedModelIds)
}
