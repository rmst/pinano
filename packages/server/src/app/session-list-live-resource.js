import { createSharedSubscribedResource } from "./live/resources.js"
import { applySessionListUpdate } from "../../../protocol/src/session-list-state.js"

const listOptions = (params) => ({
	includeDeleted: params.includeDeleted === true,
	includeHidden: params.includeHidden === true,
})

const normalizeListParams = (params = {}) => ({
	...(typeof params.cwd === "string" && params.cwd ? { cwd: params.cwd } : {}),
	...(typeof params.contextCwd === "string" && params.contextCwd ? { contextCwd: params.contextCwd } : {}),
	...(params.includeDeleted === true ? { includeDeleted: true } : {}),
	...(params.includeHidden === true ? { includeHidden: true } : {}),
})

const sessionListSnapshot = async (api, params) => {
	const cwd = typeof params.cwd === "string" && params.cwd ? params.cwd : undefined
	const [sessions, project] = await Promise.all([
		api.sessions(cwd, listOptions(params)),
		api.overviewProject?.(params.contextCwd ?? cwd),
	])
	return { type: "session_list_snapshot", sessions, project }
}

function sessionListChange(event) {
	if (event?.type === "session_list_changed") return { sessionId: event.sessionId }
	if (!event?.sessionId) return undefined
	if (event.type === "agent_view_metadata") return { sessionId: event.sessionId }
	if (event.type === "session_activity" && event.sessionListChanged === true) return { sessionId: event.sessionId }
	if (event.type === "snapshot_invalidated" && event.scopes?.includes?.("sessions")) return { sessionId: event.sessionId }
	return undefined
}

/** Authoritative filtered session collection: one initial snapshot followed by complete row upserts/removals. */
export function createSessionListLiveResource({ api, subscribeEvents }) {
	const snapshot = (params) => sessionListSnapshot(api, params)
	return createSharedSubscribedResource({
		normalize: normalizeListParams,
		snapshot,
		subscribe(params, publish) {
			const pendingIds = new Set()
			let snapshotPending = false
			let draining = false
			let closed = false

			const publishSnapshot = async () => {
				const value = await snapshot(params)
				if (!closed) publish(value)
				return value
			}
			const drain = async () => {
				if (draining || closed) return
				draining = true
				try {
					while (!closed && (snapshotPending || pendingIds.size > 0)) {
						if (snapshotPending) {
							snapshotPending = false
							pendingIds.clear()
							await publishSnapshot()
							continue
						}
						const sessionId = pendingIds.values().next().value
						pendingIds.delete(sessionId)
						try {
							const session = await api.sessionListEntry(sessionId, params.cwd, listOptions(params))
							if (!closed) publish({ type: "session_list_delta", sessionId, ...(session ? { session } : {}) })
						} catch {
							pendingIds.clear()
							await publishSnapshot()
						}
					}
				} finally {
					draining = false
					if (!closed && (snapshotPending || pendingIds.size > 0)) scheduleDrain()
				}
			}
			const scheduleDrain = () => queueMicrotask(() => void drain().catch(() => {}))
			const unsubscribe = subscribeEvents((event) => {
				const change = sessionListChange(event)
				if (!change || closed) return
				if (change.sessionId) pendingIds.add(change.sessionId)
				else snapshotPending = true
				scheduleDrain()
			})
			return {
				refresh: publishSnapshot,
				unsubscribe() {
					closed = true
					snapshotPending = false
					pendingIds.clear()
					if (typeof unsubscribe === "function") unsubscribe()
					else unsubscribe?.unsubscribe?.()
				},
			}
		},
	})
}

/** Mirror the service-owned collection into the browser gateway while preserving snapshots across local subscribers. */
export function createServiceSessionListLiveResource({ client }) {
	return createSharedSubscribedResource({
		normalize: normalizeListParams,
		snapshot: (_params, source) => source.snapshot(),
		subscribe(params, publish) {
			let current
			let initialSettled = false
			let resolveInitial
			let rejectInitial
			const initial = new Promise((resolve, reject) => {
				resolveInitial = resolve
				rejectInitial = reject
			})
			const unsubscribe = client.subscribeSessionList((update) => {
				current = applySessionListUpdate(current, update)
				if (!initialSettled) {
					initialSettled = true
					resolveInitial(current)
					return
				}
				publish(update)
			}, params, {
				onError(err) {
					if (!initialSettled) {
						initialSettled = true
						rejectInitial(err)
					}
				},
			})
			return {
				snapshot: () => current ?? initial,
				unsubscribe() {
					if (!initialSettled) {
						initialSettled = true
						const err = new Error("Session list subscription was cancelled")
						err.name = "AbortError"
						rejectInitial(err)
					}
					return unsubscribe()
				},
			}
		},
	})
}
