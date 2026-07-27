import { runNeedsAcknowledgement } from "./run-acknowledgement.js"

export const OVERVIEW_AGENT_PRIORITY = Object.freeze({
	needs_input: 0,
	experiencing_problems: 1,
	queued: 2,
	ready_for_review: 3,
	working: 4,
	discussing: 5,
	not_started: 6,
	deferred: 7,
	completed: 8,
	deleted: 9,
})

export const OVERVIEW_FOLDED_GROUP_LIMIT = 6

/** @param {unknown} value */
function isoTime(value) {
	const time = Date.parse(String(value || ""))
	return Number.isFinite(time) ? time : undefined
}

/** @param {any} session */
export function overviewLifecycleStateFor(session) {
	if (session?.deletedAt) return "deleted"
	if (session?.lifecycleState) return session.lifecycleState
	if (session?.runStatus === "running" || session?.runtimeState === "running") return "running"
	const hasVisibleConversation = Boolean(session?.preview?.first || session?.preview?.lastUser)
	if ((session?.runStatus === undefined || session?.runStatus === "idle") && !hasVisibleConversation && !session?.agentView) return "not_started"
	return "stopped"
}

/** @param {unknown} state */
export function validOverviewAgentViewState(state) {
	return state === "needs_input"
		|| state === "ready_for_review"
		|| state === "discussing"
		|| state === "deferred"
		|| state === "completed"
		|| state === "experiencing_problems"
}

/** @param {unknown} state */
function normalizedAgentViewState(state) {
	if (state === "legacy") return "completed"
	if (validOverviewAgentViewState(state)) return state
	return undefined
}

/**
 * @param {any} session
 * @param {{ lifecycleState?: string }} [options]
 */
export function overviewStateFor(session, options = {}) {
	const lifecycleState = options.lifecycleState ?? overviewLifecycleStateFor(session)
	if (lifecycleState === "deleted") return "deleted"
	if (lifecycleState === "queued") return "queued"
	if (lifecycleState === "running") return "working"
	if (runNeedsAcknowledgement(session)) return "needs_input"
	if (lifecycleState === "not_started" && !session?.agentView) return "not_started"
	return normalizedAgentViewState(session?.agentView?.state)
		?? normalizedAgentViewState(session?.agentViewFallbackState)
		?? "discussing"
}

/** @param {string | undefined} a @param {string | undefined} b */
function laterIso(a, b) {
	const timeA = isoTime(a)
	const timeB = isoTime(b)
	if (timeA === undefined) return b
	if (timeB === undefined) return a
	return timeA >= timeB ? a : b
}

/**
 * @param {any} session
 * @param {string} [state]
 */
export function overviewSortTimestampFor(session, state = overviewStateFor(session)) {
	if (state === "deleted") return session?.deletedAt ?? session?.updatedAt
	if (state === "working") return session?.latestRunStartedAt ?? session?.createdAt ?? session?.updatedAt
	return laterIso(session?.agentView?.updatedAt, session?.updatedAt) ?? session?.updatedAt
}
