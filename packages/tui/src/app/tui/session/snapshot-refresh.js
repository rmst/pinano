import { isTransientServiceTransportError } from "../service-events.js"

const SNAPSHOT_REFRESH_ERROR_NOTICE_PREFIX = "snapshot refresh error:"

const isSnapshotRefreshErrorNotice = (notice) => notice.startsWith(SNAPSHOT_REFRESH_ERROR_NOTICE_PREFIX)

const snapshotRefreshErrorNotice = (err) => `${SNAPSHOT_REFRESH_ERROR_NOTICE_PREFIX} ${err?.message ?? err}`

/**
 * Coordinates passive snapshot refreshes for the currently open chat. Refreshes are deduplicated per session, and only snapshots for the still-active chat are applied.
 * @param {{
 *   getCurrentChat: () => { sessionId?: string, updateFromEventSnapshot: (snapshot: any) => void } | undefined,
 *   snapshot: (sessionId: string) => Promise<any> | any,
 *   clearNotice: (predicate: (notice: string) => boolean) => void,
 *   setNotice: (notice: string) => void,
 *   requestRender: () => void,
 *   showStaleRuntime: (err: any) => boolean,
 * }} options
 * @returns {(sessionId: string | undefined) => Promise<void> | undefined}
 */
export function createCurrentChatSnapshotRefresher(options) {
	const pendingSessionIds = new Set()

	return (sessionId) => {
		if (!sessionId || options.getCurrentChat()?.sessionId !== sessionId || pendingSessionIds.has(sessionId)) return undefined
		pendingSessionIds.add(sessionId)
		return Promise.resolve()
			.then(() => options.snapshot(sessionId))
			.then((snapshot) => {
				const currentChat = options.getCurrentChat()
				if (currentChat?.sessionId === sessionId) {
					currentChat.updateFromEventSnapshot(snapshot)
					options.clearNotice(isSnapshotRefreshErrorNotice)
				}
				options.requestRender()
			})
			.catch((err) => {
				if (options.showStaleRuntime(err)) return
				if (isTransientServiceTransportError(err)) return
				options.setNotice(snapshotRefreshErrorNotice(err))
				options.requestRender()
			})
			.finally(() => {
				pendingSessionIds.delete(sessionId)
			})
	}
}
