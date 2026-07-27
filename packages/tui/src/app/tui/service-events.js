import { eventInvalidatesSessionSnapshot, eventNeedsSessionListRefresh } from "../../../../server/src/app/session/state.js"

/** @param {unknown} err */
export function isConnectionReset(err) {
	let cur = /** @type {any} */ (err)
	while (cur) {
		const text = `${cur?.message ?? cur}`
		if (text.includes("ECONNRESET") || text.includes("connection reset by peer")) return true
		cur = cur.cause
	}
	return false
}

/** Local service clients can briefly fail while a replacement service is accepting connections. Passive refreshes and autosaves treat these as handoff misses rather than user-visible failures. */
export function isTransientServiceTransportError(err) {
	let cur = /** @type {any} */ (err)
	while (cur) {
		const code = cur?.code
		if (["ECONNREFUSED", "ECONNRESET", "EPIPE"].includes(code)) return true
		const text = `${cur?.message ?? cur}`
		if (/\b(ECONNREFUSED|ECONNRESET|EPIPE)\b|connection reset by peer|socket hang up|broken pipe/i.test(text)) return true
		cur = cur.cause
	}
	return false
}

/** @param {unknown} err */
export function isStaleRuntimeError(err) {
	let cur = /** @type {any} */ (err)
	while (cur) {
		const text = `${cur?.message ?? cur}`
		if (/\b(?:cerex|pinano) client is stale\b/i.test(text)) return true
		cur = cur.cause
	}
	return false
}

/** @param {any} event */
export function eventIsServiceLiveRecovery(event) {
	return event?.type === "service_live_reconnected"
}

/** @param {any} event */
export function eventNeedsServiceChatSnapshot(event) {
	return eventIsServiceLiveRecovery(event) || eventInvalidatesSessionSnapshot(event) || [
		"compaction",
		"error",
	].includes(event?.type)
}

/** @param {any} event */
export function eventNeedsServiceSessionRefresh(event) {
	return eventIsServiceLiveRecovery(event) || eventNeedsSessionListRefresh(event)
}
