import { isProjectContextMessage } from "../project/context.js"
import { isSessionActivityCustomType } from "./custom-types.js"

/** @param {unknown} value */
function isoOrUndefined(value) {
	if (typeof value !== "string" && typeof value !== "number") return undefined
	const date = new Date(value)
	return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

/**
 * Return the timestamp of the latest visible user/assistant message or
 * explicit branch-changing entry appended to the session. UI row ages should
 * reflect conversation activity, not reads, metadata refreshes, or other
 * bookkeeping.
 * @param {import("../../session-manager/index.js").Session} session
 * @returns {string | undefined}
 */
export function sessionActivityAt(session) {
	const entries = session.getEntries()
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]
		if (entry.type === "custom" && isSessionActivityCustomType(entry.customType)) {
			return isoOrUndefined(entry.timestamp)
		}
		if (entry.type !== "message") continue
		const message = entry.message
		if (!message || isProjectContextMessage(message)) continue
		if (message.role !== "user" && message.role !== "assistant") continue
		return isoOrUndefined(entry.timestamp) || isoOrUndefined(message.timestamp)
	}
	return isoOrUndefined(session.getMetadata().createdAt)
}
