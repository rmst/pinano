import { overviewStateFor } from "./state.js"

export const OVERVIEW_WORKTREE_STATUS_CONCURRENCY = 2
export const OVERVIEW_WORKTREE_STATUS_REFRESH_INTERVAL_MS = 10 * 1000

/** @param {any} row */
export function overviewWorktreeRowSessionId(row) {
	if (row?.deletedAt) return undefined
	if (row?.type === "more" || row?.hasWorktrees !== true) return undefined
	return row?.id
}

/**
 * Worktree status can touch Git, so overview clients refresh it only for selected rows and rows whose cheap database projection says they have tracked worktrees.
 * @param {any[]} rows
 * @param {{ selectedId?: string | null, peekId?: string | null }} [options]
 */
export function overviewWorktreeRefreshCandidates(rows, options = {}) {
	const ids = [
		options.peekId,
		options.selectedId,
		...(Array.isArray(rows) ? rows.map(overviewWorktreeRowSessionId) : []),
	]
		.filter((id) => typeof id === "string" && id.length > 0)
	return [...new Set(ids)]
}

/**
 * Stable worktree subscription input. Row ordering and unrelated projection updates do not change the resource key.
 * @param {any[]} rows
 * @param {{ selectedId?: string | null, peekId?: string | null }} [options]
 */
export function overviewWorktreeLiveCandidates(rows, options = {}) {
	const rowById = new Map((Array.isArray(rows) ? rows : [])
		.filter((row) => typeof row?.id === "string" && row.id)
		.map((row) => [row.id, row]))
	const candidates = overviewWorktreeRefreshCandidates(rows, options).map((id) => {
		const row = rowById.get(id)
		return { id, state: row ? overviewStateFor(row) : undefined }
	})
	return candidates.sort((a, b) => a.id.localeCompare(b.id))
}
