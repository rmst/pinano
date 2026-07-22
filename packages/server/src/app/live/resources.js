import { createLiveEventBus } from "./event-bus.js"
import { eventMatchesLiveScope } from "./event-scope.js"

function cursorValid(cursor) {
	return cursor && typeof cursor.epoch === "string" && Number.isSafeInteger(cursor.revision)
}

function abortError() {
	const err = new Error("Live resource subscription was cancelled")
	err.name = "AbortError"
	return err
}

function appLiveScope(params) {
	const sessionId = typeof params.sessionId === "string" && params.sessionId ? params.sessionId : undefined
	const activeSessionId = typeof params.activeSessionId === "string" && params.activeSessionId ? params.activeSessionId : undefined
	return sessionId
		? { scope: "session", sessionId }
		: activeSessionId ? { scope: "app", sessionId: activeSessionId } : { scope: "overview" }
}

async function appLiveSnapshot(api, params) {
	if (params.worktreeStatusOnly === true) return { type: "worktree_status_snapshot" }
	const sessionId = typeof params.sessionId === "string" && params.sessionId ? params.sessionId : undefined
	if (sessionId) {
		const { cwd, contextCwd, includeDeleted, includeHidden, activeSessionId, excludeSessions, excludeWorktreeStatus, worktreeStatusOnly, sessionId: ignoredSessionId, ...snapshotOptions } = params
		void cwd
		void contextCwd
		void includeDeleted
		void includeHidden
		void activeSessionId
		void excludeSessions
		void excludeWorktreeStatus
		void worktreeStatusOnly
		void ignoredSessionId
		const snapshot = await api.snapshot(sessionId, snapshotOptions)
		if (snapshot.sessionId && snapshot.sessionId !== sessionId) throw new Error(`Session snapshot id mismatch: expected ${sessionId}, got ${snapshot.sessionId}`)
		return { type: "snapshot", sessionId, snapshot }
	}
	if (params.excludeSessions === true) return { type: "app_ready" }
	const [sessions, project] = await Promise.all([
		api.sessions(params.cwd, { includeDeleted: params.includeDeleted === true, includeHidden: params.includeHidden === true }),
		api.overviewProject(params.contextCwd ?? params.cwd),
	])
	return { type: "sessions", sessions, project }
}

function appLiveEventMatches(params, scope, event) {
	if (params.worktreeStatusOnly === true) return event?.type === "worktree_status"
	if (params.excludeWorktreeStatus === true && event?.type === "worktree_status") return false
	if (params.excludeSessions === true) {
		if (event?.type === "sessions" || event?.type === "session_list_changed") return false
		if (event?.type === "agent_view_metadata" && event?.sessionId !== scope.sessionId) return false
		if (event?.type === "snapshot_invalidated" && (event?.sessionId !== scope.sessionId || !event?.scopes?.includes?.("session"))) return false
	}
	return eventMatchesLiveScope(scope, event)
}

export function createAppLiveResource({ api, hub }) {
	return {
		async open(params, context) {
			const client = appLiveScope(params)
			const subscription = hub.subscribe((record) => context.emit({ cursor: record.cursor, data: record.value }), {
				...(cursorValid(context.cursor) ? { cursor: context.cursor } : {}),
				filter: (event) => appLiveEventMatches(params, client, event),
			})
			const unsubscribe = () => {
				context.signal?.removeEventListener?.("abort", unsubscribe)
				subscription.unsubscribe()
			}
			context.signal?.addEventListener?.("abort", unsubscribe, { once: true })
			if (cursorValid(context.cursor) && !subscription.reset) {
				return { resumed: true, cursor: context.cursor, unsubscribe }
			}
			try {
				return {
					cursor: subscription.cursor,
					snapshot: await appLiveSnapshot(api, params),
					unsubscribe,
				}
			} catch (err) {
				unsubscribe()
				throw err
			}
		},
	}
}

function canonicalJsonValue(value) {
	if (Array.isArray(value)) return value.map(canonicalJsonValue)
	if (!value || typeof value !== "object") return value
	return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJsonValue(value[key])]))
}

function defaultKey(params) {
	return JSON.stringify(canonicalJsonValue(params))
}

/**
 * Share one demand-driven event subscription for each normalized key while retaining bounded replay history and taking a race-free snapshot for new subscribers.
 */
export function createSharedSubscribedResource(options) {
	const states = new Map()
	const normalize = options.normalize ?? (async (params) => params)
	const keyFor = options.key ?? defaultKey
	const closeState = (state) => {
		try {
			const result = state.source?.unsubscribe?.()
			result?.catch?.(() => {})
		} catch {}
		state.source = undefined
		state.bus.close()
		states.delete(state.key)
	}
	return {
		async open(params, context) {
			const normalized = await normalize(params)
			if (context.signal?.aborted) throw abortError()
			const key = keyFor(normalized)
			let state = states.get(key)
			if (!state) {
				state = {
					key,
					params: normalized,
					bus: createLiveEventBus({ historySize: options.historySize ?? 512 }),
					refs: 0,
					source: undefined,
				}
				states.set(key, state)
			}
			state.refs++
			const subscription = state.bus.subscribe((record) => context.emit({ cursor: record.cursor, data: record.value }), {
				...(cursorValid(context.cursor) ? { cursor: context.cursor } : {}),
			})
			let released = false
			const unsubscribe = () => {
				if (released) return
				released = true
				context.signal?.removeEventListener?.("abort", unsubscribe)
				subscription.unsubscribe()
				state.refs = Math.max(0, state.refs - 1)
				if (state.refs === 0) closeState(state)
			}
			context.signal?.addEventListener?.("abort", unsubscribe, { once: true })
			try {
				if (!state.source) {
					const source = options.subscribe(state.params, (value) => state.bus.publish(value))
					state.source = typeof source === "function" ? { unsubscribe: source } : source
					if (typeof state.source?.unsubscribe !== "function") throw new Error("Live resource subscribe must return an unsubscribe function or source descriptor")
				}
				const refresh = typeof state.source.refresh === "function" ? { refresh: () => state.source?.refresh?.() } : {}
				if (cursorValid(context.cursor) && !subscription.reset) {
					return { resumed: true, cursor: context.cursor, unsubscribe, ...refresh }
				}
				const boundary = subscription.cursor
				const snapshot = await options.snapshot(state.params, state.source)
				return { snapshot, cursor: boundary, unsubscribe, ...refresh }
			} catch (err) {
				unsubscribe()
				throw err
			}
		},
		inspect() {
			return { keys: states.size, subscriptions: [...states.values()].reduce((total, state) => total + state.refs, 0) }
		},
		close() {
			for (const state of [...states.values()]) closeState(state)
		},
	}
}

export function createServiceAppLiveResource({ api, client }) {
	return createSharedSubscribedResource({
		subscribe(params, publish) {
			const scope = appLiveScope(params)
			return client.subscribe((event) => {
				if (event?.type === "service_live_reconnected" || appLiveEventMatches(params, scope, event)) publish(event)
			}, {
				...(scope.scope === "session" ? { sessionId: scope.sessionId } : {}),
				...(scope.scope === "app" ? { activeSessionId: scope.sessionId } : {}),
				...(scope.scope !== "session" && params.includeDeleted === true ? { includeDeleted: true } : {}),
				...(scope.scope !== "session" && params.includeHidden === true ? { includeHidden: true } : {}),
				...(params.excludeWorktreeStatus === true ? { excludeWorktreeStatus: true } : {}),
				...(params.excludeSessions === true ? { excludeSessions: true } : {}),
				...(params.worktreeStatusOnly === true ? { worktreeStatusOnly: true } : {}),
				emitInitialSnapshot: false,
			})
		},
		snapshot: (params) => appLiveSnapshot(api, params),
	})
}

/**
 * Share one serialized, demand-driven refresh loop for each normalized resource key. The loop stops with the last subscriber and never overlaps a prior load.
 */
export function createSharedPollingResource(options) {
	const states = new Map()
	const intervalMs = Number.isFinite(options.intervalMs) ? Math.max(0, options.intervalMs) : 10000
	const maxConcurrent = Number.isSafeInteger(options.maxConcurrent) ? Math.max(1, options.maxConcurrent) : Number.POSITIVE_INFINITY
	const pendingLoads = []
	let activeLoads = 0
	const keyFor = options.key ?? defaultKey
	const hash = options.hash ?? JSON.stringify
	const drainLoads = () => {
		while (activeLoads < maxConcurrent && pendingLoads.length > 0) {
			const pending = pendingLoads.shift()
			activeLoads++
			Promise.resolve().then(pending.load).then(pending.resolve, pending.reject).finally(() => {
				activeLoads--
				drainLoads()
			})
		}
	}
	const limitedLoad = (load) => new Promise((resolve, reject) => {
		pendingLoads.push({ load, resolve, reject })
		drainLoads()
	})
	const stateFor = (params) => {
		const key = keyFor(params)
		let state = states.get(key)
		if (state) return state
		state = {
			key,
			params,
			bus: createLiveEventBus({ historySize: options.historySize ?? 32 }),
			value: undefined,
			valueHash: undefined,
			refs: 0,
			timer: undefined,
			loading: undefined,
		}
		states.set(key, state)
		return state
	}
	const refresh = (state) => {
		if (state.loading) return state.loading
		state.loading = limitedLoad(() => state.refs > 0 ? options.load(state.params) : state.value)
			.then((value) => {
				const valueHash = hash(value)
				if (state.value === undefined || valueHash !== state.valueHash) {
					state.value = value
					state.valueHash = valueHash
					state.bus.publish(value)
				}
				return state.value
			})
			.finally(() => {
				state.loading = undefined
			})
		return state.loading
	}
	const schedule = (state) => {
		if (intervalMs <= 0 || state.refs <= 0 || state.timer) return
		state.timer = setTimeout(async () => {
			state.timer = undefined
			try { await refresh(state) } catch {}
			schedule(state)
		}, intervalMs)
		state.timer.unref?.()
	}
	return {
		async open(params, context) {
			const state = stateFor(params)
			state.refs++
			const subscription = state.bus.subscribe((record) => context.emit({ cursor: record.cursor, data: record.value }), {
				...(cursorValid(context.cursor) ? { cursor: context.cursor } : {}),
			})
			let released = false
			const unsubscribe = () => {
				if (released) return
				released = true
				context.signal?.removeEventListener?.("abort", unsubscribe)
				subscription.unsubscribe()
				state.refs = Math.max(0, state.refs - 1)
				if (state.refs === 0) {
					if (state.timer) clearTimeout(state.timer)
					state.timer = undefined
					states.delete(state.key)
					state.bus.close()
				}
			}
			context.signal?.addEventListener?.("abort", unsubscribe, { once: true })
			try {
				if (cursorValid(context.cursor) && !subscription.reset && state.value !== undefined) {
					schedule(state)
					return { resumed: true, cursor: context.cursor, unsubscribe, refresh: () => refresh(state) }
				}
				await refresh(state)
				schedule(state)
				return { snapshot: state.value, cursor: state.bus.cursor(), unsubscribe, refresh: () => refresh(state) }
			} catch (err) {
				unsubscribe()
				throw err
			}
		},
		inspect() {
			return { keys: states.size, subscriptions: [...states.values()].reduce((total, state) => total + state.refs, 0) }
		},
		close() {
			for (const state of states.values()) {
				if (state.timer) clearTimeout(state.timer)
				state.bus.close()
			}
			states.clear()
		},
	}
}

/**
 * Share one event source for each normalized key. This is intended for resources such as filesystem watches where the payload invalidates a separately fetched representation.
 */
export function createSharedWatchResource(options) {
	const states = new Map()
	const normalize = options.normalize ?? (async (params) => params)
	const keyFor = options.key ?? defaultKey
	const debounceMs = Number.isFinite(options.debounceMs) ? Math.max(0, options.debounceMs) : 50
	const closeState = (state) => {
		if (state.timer) clearTimeout(state.timer)
		state.timer = undefined
		try { state.watcher?.close?.() } catch {}
		state.watcher = undefined
		state.bus.close()
		states.delete(state.key)
	}
	const publish = (state, value = undefined, error = undefined) => {
		state.pendingValue = value && typeof value === "object" ? value : undefined
		state.pendingError = error
		if (state.timer) return
		state.timer = setTimeout(() => {
			state.timer = undefined
			const pendingValue = state.pendingValue
			const pendingError = state.pendingError
			state.pendingValue = undefined
			state.pendingError = undefined
			state.bus.publish({
				changedAt: new Date().toISOString(),
				...pendingValue,
				...(pendingError ? { error: pendingError?.message ?? String(pendingError) } : {}),
			})
		}, debounceMs)
		state.timer.unref?.()
	}
	return {
		async open(params, context) {
			const normalized = await normalize(params)
			if (context.signal?.aborted) throw abortError()
			const key = keyFor(normalized)
			let state = states.get(key)
			if (!state) {
				state = {
					key,
					params: normalized,
					bus: createLiveEventBus({ historySize: options.historySize ?? 32 }),
					refs: 0,
					timer: undefined,
					watcher: undefined,
					pendingValue: undefined,
					pendingError: undefined,
				}
				states.set(key, state)
			}
			state.refs++
			const subscription = state.bus.subscribe((record) => context.emit({ cursor: record.cursor, data: record.value }), {
				...(cursorValid(context.cursor) ? { cursor: context.cursor } : {}),
			})
			let released = false
			const unsubscribe = () => {
				if (released) return
				released = true
				context.signal?.removeEventListener?.("abort", unsubscribe)
				subscription.unsubscribe()
				state.refs = Math.max(0, state.refs - 1)
				if (state.refs === 0) closeState(state)
			}
			context.signal?.addEventListener?.("abort", unsubscribe, { once: true })
			try {
				if (!state.watcher) state.watcher = options.watch(state.params, (value) => publish(state, value), (err) => publish(state, undefined, err))
				if (cursorValid(context.cursor) && !subscription.reset) {
					return { resumed: true, cursor: context.cursor, unsubscribe }
				}
				return {
					snapshot: { watching: true },
					cursor: state.bus.cursor(),
					unsubscribe,
				}
			} catch (err) {
				unsubscribe()
				throw err
			}
		},
		inspect() {
			return { keys: states.size, subscriptions: [...states.values()].reduce((total, state) => total + state.refs, 0) }
		},
		close() {
			for (const state of [...states.values()]) closeState(state)
		},
	}
}
