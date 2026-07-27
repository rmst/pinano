export const DEFAULT_WORKTREE_STATUS_RUNNING_TTL_MS = 10 * 1000
export const DEFAULT_WORKTREE_STATUS_ACTIVE_TTL_MS = 30 * 1000
export const DEFAULT_WORKTREE_STATUS_DEFERRED_TTL_MS = 10 * 60 * 1000
export const DEFAULT_WORKTREE_STATUS_COMPLETED_TTL_MS = 60 * 60 * 1000
export const DEFAULT_WORKTREE_STATUS_CACHE_MAX_ENTRIES = 1000

export const DEFAULT_WORKTREE_STATUS_TTLS = Object.freeze({
	runningTtlMs: DEFAULT_WORKTREE_STATUS_RUNNING_TTL_MS,
	activeTtlMs: DEFAULT_WORKTREE_STATUS_ACTIVE_TTL_MS,
	deferredTtlMs: DEFAULT_WORKTREE_STATUS_DEFERRED_TTL_MS,
	completedTtlMs: DEFAULT_WORKTREE_STATUS_COMPLETED_TTL_MS,
})

/** @param {string | undefined} state */
export function worktreeStatusTtlMsForState(state, options = DEFAULT_WORKTREE_STATUS_TTLS) {
	if (state === "running" || state === "working") return options.runningTtlMs
	if (state === "completed") return options.completedTtlMs
	if (state === "deferred") return options.deferredTtlMs
	return options.activeTtlMs
}
