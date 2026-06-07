const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const UUID_WORKSPACE_HEX_LENGTH = 12

/** @param {unknown} value */
export function safePathComponent(value) {
	return String(value || "local").replace(/[^A-Za-z0-9_-]/g, "_")
}

/** @param {unknown} value */
export function isUuidSessionId(value) {
	return typeof value === "string" && UUID_RE.test(value)
}

/** @param {string} sessionId */
export function uuidSessionIdHex(sessionId) {
	return sessionId.replaceAll("-", "").toLowerCase()
}

/**
 * Directory name for a session workspace under $PINANO_HOME/sessions.
 * UUID session ids keep their full canonical id in the database/API, but use a
 * short deterministic workspace name to keep tool-visible paths readable.
 * @param {string} sessionId
 * @returns {string}
 */
export function sessionWorkspaceDirName(sessionId) {
	return isUuidSessionId(sessionId)
		? uuidSessionIdHex(sessionId).slice(0, UUID_WORKSPACE_HEX_LENGTH)
		: safePathComponent(sessionId)
}
