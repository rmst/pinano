const PROBLEM_RUN_STATUSES = new Set(["failed", "aborted", "interrupted"])

export const OVERVIEW_AGENT_PRIORITY = Object.freeze({
	needs_input: 0,
	experiencing_problems: 1,
	queued: 2,
	ready_for_review: 3,
	working: 4,
	not_started: 5,
	deferred: 6,
	completed: 7,
})

/** @param {unknown} value */
function isoTime(value) {
	const time = Date.parse(String(value || ""))
	return Number.isFinite(time) ? time : undefined
}

/** @param {any} session */
export function overviewLifecycleStateFor(session) {
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

/** @param {any} session */
function problemRunTime(session) {
	if (!PROBLEM_RUN_STATUSES.has(session?.runStatus)) return undefined
	return isoTime(session.latestRunEndedAt) ?? isoTime(session.latestRunStartedAt)
}

/** @param {any} session */
export function overviewRunProblemIsUnresolved(session) {
	if (!PROBLEM_RUN_STATUSES.has(session?.runStatus)) return false
	const runTime = problemRunTime(session)
	const agentViewTime = isoTime(session?.agentView?.updatedAt)
	return runTime === undefined || agentViewTime === undefined || runTime > agentViewTime
}

/**
 * @param {any} session
 * @param {{ lifecycleState?: string }} [options]
 */
export function overviewStateFor(session, options = {}) {
	const lifecycleState = options.lifecycleState ?? overviewLifecycleStateFor(session)
	if (lifecycleState === "queued") return "queued"
	if (lifecycleState === "running") return "working"
	if (overviewRunProblemIsUnresolved(session)) return "needs_input"
	if (lifecycleState === "not_started" && !session?.agentView) return "not_started"
	return normalizedAgentViewState(session?.agentView?.state)
		?? normalizedAgentViewState(session?.agentViewFallbackState)
		?? "ready_for_review"
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
	if (state === "working") return session?.latestRunStartedAt ?? session?.createdAt ?? session?.updatedAt
	return laterIso(session?.agentView?.updatedAt, session?.updatedAt) ?? session?.updatedAt
}
