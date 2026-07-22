import { createSharedSubscribedResource } from "./live/resources.js"
import {
	OVERVIEW_WORKTREE_STATUS_CONCURRENCY,
	OVERVIEW_WORKTREE_STATUS_REFRESH_INTERVAL_MS,
} from "./overview-worktree-refresh.js"
import {
	DEFAULT_WORKTREE_STATUS_CACHE_MAX_ENTRIES,
	DEFAULT_WORKTREE_STATUS_TTLS,
	worktreeStatusTtlMsForState,
} from "./worktree-status-policy.js"

export const OVERVIEW_WORKTREE_STATUS_MAX_CANDIDATES = 2000
export const OVERVIEW_WORKTREE_STATUS_BATCH_DELAY_MS = 50

function normalizeCandidates(params, maxCandidates) {
	const candidates = Array.isArray(params?.candidates) ? params.candidates : []
	const byId = new Map()
	for (const candidate of candidates) {
		const id = typeof candidate?.id === "string" ? candidate.id.trim() : ""
		if (!id || id.length > 120) throw Object.assign(new Error("Invalid overview worktree candidate"), { status: 400 })
		const state = typeof candidate.state === "string" && candidate.state.length <= 64 ? candidate.state : undefined
		byId.set(id, { id, state })
	}
	if (byId.size > maxCandidates) throw Object.assign(new Error(`Overview worktree subscriptions support at most ${maxCandidates} candidates`), { status: 413 })
	return { candidates: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)) }
}

/**
 * One overview subscription fans into a bounded status queue. Cache and in-flight work are shared across equivalent browser clients and candidate-set transitions.
 */
export function createOverviewWorktreeLiveResource(options) {
	const now = options.now ?? Date.now
	const intervalMs = Number.isFinite(options.intervalMs) ? Math.max(0, options.intervalMs) : OVERVIEW_WORKTREE_STATUS_REFRESH_INTERVAL_MS
	const batchDelayMs = Number.isFinite(options.batchDelayMs) ? Math.max(0, options.batchDelayMs) : OVERVIEW_WORKTREE_STATUS_BATCH_DELAY_MS
	const maxConcurrent = Number.isSafeInteger(options.maxConcurrent) ? Math.max(1, options.maxConcurrent) : OVERVIEW_WORKTREE_STATUS_CONCURRENCY
	const maxCandidates = Number.isSafeInteger(options.maxCandidates) ? Math.max(1, options.maxCandidates) : OVERVIEW_WORKTREE_STATUS_MAX_CANDIDATES
	const maxOutstandingLoads = Number.isSafeInteger(options.maxOutstandingLoads) ? Math.max(1, options.maxOutstandingLoads) : maxCandidates
	const maxCacheEntries = Number.isSafeInteger(options.maxCacheEntries)
		? Math.max(1, options.maxCacheEntries)
		: Math.max(DEFAULT_WORKTREE_STATUS_CACHE_MAX_ENTRIES, maxCandidates)
	const ttlOptions = options.ttlOptions ?? DEFAULT_WORKTREE_STATUS_TTLS
	const cache = new Map()
	const sources = new Set()
	const queuedIds = new Set()
	const pendingIds = []
	const loadingIds = new Set()
	let activeLoads = 0
	let eventUnsubscribe
	let closed = false

	const sourceWants = (id) => {
		for (const source of sources) {
			if (source.ids.has(id)) return true
		}
		return false
	}
	const hasEventDemand = () => {
		for (const source of sources) {
			if (source.ids.size > 0) return true
		}
		return false
	}
	const pruneQueuedLoads = () => {
		const wanted = pendingIds.filter(sourceWants)
		if (wanted.length === pendingIds.length) return
		pendingIds.length = 0
		pendingIds.push(...wanted)
		queuedIds.clear()
		for (const id of wanted) queuedIds.add(id)
	}
	const pruneCache = () => {
		while (cache.size > maxCacheEntries) cache.delete(cache.keys().next().value)
	}
	const setCache = (id, worktrees, loadedAt) => {
		const entry = {
			worktrees: Array.isArray(worktrees) ? worktrees : [],
			loadedAt: Number.isFinite(loadedAt) ? loadedAt : now(),
		}
		cache.delete(id)
		cache.set(id, entry)
		pruneCache()
		return entry
	}
	const flushSource = (source) => {
		source.batchTimer = undefined
		if (source.closed || source.pending.size === 0) return
		const entries = Object.fromEntries(source.pending)
		source.pending.clear()
		source.publish({ entries })
	}
	const queueSourceEntry = (source, id, entry) => {
		if (source.closed || !source.ids.has(id)) return
		source.pending.set(id, entry)
		if (source.batchTimer) return
		source.batchTimer = setTimeout(() => flushSource(source), batchDelayMs)
		source.batchTimer.unref?.()
	}
	const publishEntry = (id, entry) => {
		for (const source of sources) queueSourceEntry(source, id, entry)
	}
	const acceptEvent = (event) => {
		if (event?.type !== "worktree_status" || typeof event.sessionId !== "string") return
		if (!sourceWants(event.sessionId)) return
		const previous = cache.get(event.sessionId)
		const loadedAt = Number.isFinite(event.loadedAt) ? event.loadedAt : now()
		if (previous && previous.loadedAt > loadedAt) return
		const entry = setCache(event.sessionId, event.worktrees, loadedAt)
		publishEntry(event.sessionId, entry)
	}
	const startEvents = () => {
		if (eventUnsubscribe || !options.subscribeEvents) return
		const unsubscribe = options.subscribeEvents(acceptEvent)
		eventUnsubscribe = typeof unsubscribe === "function" ? unsubscribe : () => unsubscribe?.unsubscribe?.()
	}
	const stopEvents = () => {
		const unsubscribe = eventUnsubscribe
		eventUnsubscribe = undefined
		try {
			const result = unsubscribe?.()
			result?.catch?.(() => {})
		} catch {}
	}
	const drain = () => {
		while (!closed && activeLoads < maxConcurrent && pendingIds.length > 0) {
			const id = pendingIds.shift()
			queuedIds.delete(id)
			if (!sourceWants(id) || loadingIds.has(id)) continue
			activeLoads++
			loadingIds.add(id)
			const startedAt = now()
			Promise.resolve()
				.then(() => options.load(id))
				.then((worktrees) => {
					if (closed) return
					const current = cache.get(id)
					if (current && current.loadedAt >= startedAt) return
					publishEntry(id, setCache(id, worktrees, now()))
				})
				.catch(() => {})
				.finally(() => {
					activeLoads--
					loadingIds.delete(id)
					drain()
				})
		}
	}
	const queueLoad = (id) => {
		if (closed || queuedIds.has(id) || loadingIds.has(id)) return
		if (queuedIds.size + loadingIds.size >= maxOutstandingLoads) return
		queuedIds.add(id)
		pendingIds.push(id)
		drain()
	}
	const refreshSource = (source, force = false) => {
		if (source.closed) return
		const currentTime = now()
		for (const candidate of source.candidates) {
			const entry = cache.get(candidate.id)
			const ttlMs = worktreeStatusTtlMsForState(candidate.state, ttlOptions)
			if (force || !entry || currentTime - entry.loadedAt > ttlMs) queueLoad(candidate.id)
		}
	}
	const scheduleSource = (source) => {
		if (source.closed || intervalMs <= 0) return
		source.pollTimer = setTimeout(() => {
			source.pollTimer = undefined
			refreshSource(source)
			scheduleSource(source)
		}, intervalMs)
		source.pollTimer.unref?.()
	}
	const subscribe = (params, publish) => {
		const source = {
			candidates: params.candidates,
			ids: new Set(params.candidates.map((candidate) => candidate.id)),
			publish,
			pending: new Map(),
			batchTimer: undefined,
			pollTimer: undefined,
			initialTimer: undefined,
			closed: false,
		}
		sources.add(source)
		if (source.ids.size > 0) startEvents()
		source.initialTimer = setTimeout(() => {
			source.initialTimer = undefined
			refreshSource(source)
			scheduleSource(source)
		}, 0)
		source.initialTimer.unref?.()
		return {
			refresh: () => refreshSource(source, true),
			unsubscribe() {
				if (source.closed) return
				source.closed = true
				if (source.initialTimer) clearTimeout(source.initialTimer)
				if (source.pollTimer) clearTimeout(source.pollTimer)
				if (source.batchTimer) clearTimeout(source.batchTimer)
				source.pending.clear()
				sources.delete(source)
				pruneQueuedLoads()
				if (!hasEventDemand()) stopEvents()
			},
		}
	}
	const shared = createSharedSubscribedResource({
		normalize: (params) => normalizeCandidates(params, maxCandidates),
		subscribe,
		snapshot(params) {
			const entries = {}
			for (const candidate of params.candidates) {
				const entry = cache.get(candidate.id)
				if (entry) entries[candidate.id] = entry
			}
			return { entries }
		},
		historySize: options.historySize ?? 64,
	})

	return {
		open: shared.open,
		inspect() {
			return {
				...shared.inspect(),
				cacheEntries: cache.size,
				sources: sources.size,
				queuedLoads: pendingIds.length,
				activeLoads,
			}
		},
		close() {
			if (closed) return
			closed = true
			shared.close()
			stopEvents()
			pendingIds.length = 0
			queuedIds.clear()
			cache.clear()
		},
	}
}
