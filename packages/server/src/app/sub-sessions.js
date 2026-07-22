import { routeToArg, sessionRoute } from "./routes.js"

export const SUB_SESSION_DEFAULT_FORK_TURNS = "all"
export const SUB_SESSION_MAX_DEPTH = 3
export const SUB_SESSION_MAX_OPEN_PER_ROOT = 8

const SUB_SESSION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/

export function normalizeSubSessionForkTurns(value = SUB_SESSION_DEFAULT_FORK_TURNS) {
	if (value === undefined || value === null || value === "") return SUB_SESSION_DEFAULT_FORK_TURNS
	if (value === "all" || value === "none") return value
	const n = Number(value)
	if (Number.isInteger(n) && n > 0) return String(n)
	throw Object.assign(new Error("forkTurns must be \"all\", \"none\", or a positive integer"), { status: 400 })
}

export function normalizeSubSessionName(value) {
	const name = String(value ?? "").trim()
	if (!name) return undefined
	if (!SUB_SESSION_NAME_RE.test(name)) {
		throw Object.assign(new Error("sub-session name must start with a letter or number and contain only letters, numbers, - and _"), { status: 400 })
	}
	return name
}

export function defaultSubSessionName(existingNames) {
	for (let i = 1; i < 1000; i += 1) {
		const name = `agent-${i}`
		if (!existingNames.has(name)) return name
	}
	throw new Error("Could not allocate a sub-session name")
}

export function subSessionOpenCommand(sessionId) {
	return `pinano open ${routeToArg(sessionRoute(sessionId))}`
}

export function subSessionConfig(record) {
	return {
		version: 1,
		parentSessionId: record.parentSessionId,
		rootSessionId: record.rootSessionId,
		name: record.name,
		origin: record.origin,
		forkTurns: record.forkTurns,
		depth: record.depth,
		branchEntryId: record.branchEntryId ?? null,
	}
}

export function subSessionStatus(row, sessionEntry = undefined, liveRunning = false) {
	if (row?.closedAt) return "closed"
	if (liveRunning || sessionEntry?.runStatus === "running" || sessionEntry?.runtimeState === "running") return "running"
	if (sessionEntry?.runStatus === "failed" || sessionEntry?.runtimeState === "failed") return "failed"
	if (sessionEntry?.runStatus === "interrupted" || sessionEntry?.runtimeState === "interrupted") return "interrupted"
	if (sessionEntry?.runStatus === "aborted" || sessionEntry?.runtimeState === "aborted") return "aborted"
	return "idle"
}

export function formatSubSessionToolResult(action, item, extra = {}) {
	const lines = [
		`${action}: ${item.name}`,
		`sessionId: ${item.childSessionId}`,
		`status: ${item.status}`,
		`open: ${subSessionOpenCommand(item.childSessionId)}`,
	]
	if (item.task) lines.push(`task: ${item.task}`)
	if (extra.message) lines.push("", extra.message)
	return lines.join("\n")
}
