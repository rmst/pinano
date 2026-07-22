const ACKNOWLEDGEMENT_RUN_STATUSES = new Set(["failed", "aborted", "interrupted"])

/** @param {unknown} value */
function isoTime(value) {
	const time = Date.parse(String(value || ""))
	return Number.isFinite(time) ? time : undefined
}

/** @param {any} session */
function acknowledgementRunTime(session) {
	if (!ACKNOWLEDGEMENT_RUN_STATUSES.has(session?.runStatus)) return undefined
	return isoTime(session.latestRunEndedAt) ?? isoTime(session.latestRunStartedAt)
}

/** @param {any} session */
export function runNeedsAcknowledgement(session) {
	if (!ACKNOWLEDGEMENT_RUN_STATUSES.has(session?.runStatus)) return false
	const runTime = acknowledgementRunTime(session)
	const agentViewTime = isoTime(session?.agentView?.updatedAt)
	return runTime === undefined || agentViewTime === undefined || runTime > agentViewTime
}

/** @param {any} session */
export function runAcknowledgementKind(session) {
	if (!runNeedsAcknowledgement(session)) return undefined
	return session?.runStatus === "failed" ? "problem" : "stopped"
}
