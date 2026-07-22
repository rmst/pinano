const OVERVIEW_EVENT_TYPES = new Set([
	"agent_view_metadata",
	"session_activity",
	"session_list_changed",
	"sessions",
	"worktree_status",
])
const OVERVIEW_ONLY_EVENT_TYPES = new Set([
	"session_activity",
	"sessions",
])

function snapshotInvalidationMatchesScope(scope, event) {
	const scopes = Array.isArray(event?.scopes) ? event.scopes : ["session"]
	return scopes.includes(scope)
}

function eventHasSessionId(event, sessionId) {
	return event?.sessionId === sessionId || event?.snapshot?.sessionId === sessionId
}

/** Match an application event to an overview, session, or combined app subscription independently of its transport. */
export function eventMatchesLiveScope(client, event) {
	const scope = client?.scope ?? (client?.sessionId ? "session" : "overview")
	if (scope === "app") {
		return eventMatchesLiveScope({ scope: "overview" }, event)
			|| eventMatchesLiveScope({ scope: "session", sessionId: client?.sessionId }, event)
	}
	if (scope === "overview") {
		if (event?.type === "snapshot_invalidated") return snapshotInvalidationMatchesScope("sessions", event)
		return OVERVIEW_EVENT_TYPES.has(event?.type) || !event?.sessionId && !event?.snapshot?.sessionId
	}
	if (!client?.sessionId || OVERVIEW_ONLY_EVENT_TYPES.has(event?.type)) return false
	if (event?.type === "snapshot_invalidated" && !snapshotInvalidationMatchesScope("session", event)) return false
	return eventHasSessionId(event, client.sessionId)
}
