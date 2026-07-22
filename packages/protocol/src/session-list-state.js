function sessionListSortValue(session) {
	return String(session?.deletedAt || session?.updatedAt || "")
}

export function sortSessionList(sessions) {
	return [...sessions].sort((left, right) => {
		const deleted = Number(Boolean(left?.deletedAt)) - Number(Boolean(right?.deletedAt))
		if (deleted !== 0) return deleted
		const primary = sessionListSortValue(right).localeCompare(sessionListSortValue(left))
		if (primary !== 0) return primary
		return String(right?.updatedAt || "").localeCompare(String(left?.updatedAt || ""))
	})
}

/** Apply a complete snapshot or one authoritative row delta without mutating the current value. */
export function applySessionListUpdate(current, update) {
	if (update?.type === "session_list_snapshot") {
		return {
			...update,
			sessions: Array.isArray(update.sessions) ? update.sessions : [],
		}
	}
	if (update?.type !== "session_list_delta" || !update.sessionId) return current
	const sessions = Array.isArray(current?.sessions) ? current.sessions : []
	const remaining = sessions.filter((session) => session?.id !== update.sessionId)
	return {
		type: "session_list_snapshot",
		sessions: update.session ? sortSessionList([...remaining, update.session]) : remaining,
		...(current && Object.prototype.hasOwnProperty.call(current, "project") ? { project: current.project } : {}),
	}
}
