function valueOrDash(value) {
	return value === undefined || value === null || value === "" ? "-" : String(value)
}

function shortId(value) {
	return typeof value === "string" && value.length > 12 ? value.slice(0, 12) : valueOrDash(value)
}

function formatWebStatus(web) {
	if (!web?.running) return "stopped"
	const host = web.host ?? "127.0.0.1"
	const port = web.port ?? web.requestedPort ?? "?"
	const publicUrl = web.publicUrl ? ` (${web.publicUrl})` : ""
	return `${host}:${port}${publicUrl}`
}

function formatTransport(info) {
	if (!info) return "-"
	if (info.transport === "tcp") {
		const fallback = info.portFallback && info.requestedPort ? ` (fallback from ${info.requestedPort})` : ""
		return `tcp:${valueOrDash(info.host || "127.0.0.1")}:${valueOrDash(info.port)}${fallback}`
	}
	return `unsupported:${valueOrDash(info.transport)}`
}

function formatIdleShutdown(info, health) {
	const enabled = health?.idleShutdown ?? info?.idleShutdown
	const delayMs = health?.idleShutdownDelayMs ?? info?.idleShutdownDelayMs
	if (enabled === false) return "disabled"
	if (enabled === true) return Number.isFinite(delayMs) ? `enabled (${delayMs}ms)` : "enabled"
	return "-"
}

function lifecycleStatusLines(lifecycle) {
	const operation = lifecycle?.operation
	const lock = lifecycle?.lock
	const lines = [`lifecycle: ${valueOrDash(lifecycle?.state ?? "idle")}`]
	if (operation) {
		lines.push(
			`lifecycle phase: ${valueOrDash(operation.phase)}`,
			`lifecycle operation: ${shortId(operation.operationId)}`,
			`lifecycle owner pid: ${valueOrDash(operation.ownerPid)}`,
			`lifecycle owner started: ${valueOrDash(operation.startedAt)}`,
			`lifecycle heartbeat: ${valueOrDash(operation.heartbeatAt)}`,
			`lifecycle old run: ${shortId(operation.oldServiceRunId)}`,
			`lifecycle old pid: ${valueOrDash(operation.oldPid)}`,
			`lifecycle new run: ${shortId(operation.newServiceRunId)}`,
			`lifecycle message: ${valueOrDash(operation.message)}`,
			`lifecycle info: ${valueOrDash(lifecycle.operationPath)}`,
		)
	}
	if (lock) {
		lines.push(
			`lifecycle lock: ${lock.stale ? "stale" : "held"}`,
			`lifecycle lock owner pid: ${valueOrDash(lock.owner?.pid)}`,
			`lifecycle lock heartbeat: ${valueOrDash(lock.heartbeatAt)}`,
			`lifecycle lock info: ${valueOrDash(lock.path)}`,
		)
	}
	return lines
}

export function formatServiceStatus(status) {
	const info = status.info
	const health = status.health
	const state = status.alive ? "alive" : info ? (status.pidAlive ? "unhealthy" : "stopped") : "not running"
	const lines = [
		`pinano service: ${state}`,
		...lifecycleStatusLines(status.lifecycle),
		`pid: ${valueOrDash(info?.pid)}${status.pidAlive ? " (alive)" : info ? " (not running)" : ""}`,
		`run: ${shortId(info?.serviceRunId ?? health?.serviceRunId)}`,
		`started: ${valueOrDash(info?.startedAt)}`,
		`cwd: ${valueOrDash(info?.cwd ?? health?.cwd)}`,
		`main: ${valueOrDash(info?.mainPath ?? health?.mainPath)}`,
		`exec: ${valueOrDash(info?.execPath ?? health?.execPath)}`,
		`desired: ${valueOrDash(status.desiredRuntime?.mainPath ?? status.desiredRuntime?.packageRoot)}`,
		`transport: ${formatTransport(info)}`,
		`idle shutdown: ${formatIdleShutdown(info, health)}`,
		`web: ${formatWebStatus(health?.web)}`,
		`active requests: ${valueOrDash(health?.activeRequests)}`,
		`running sessions: ${health?.runningSessions?.length ?? 0}`,
		`background sessions: ${health?.backgroundSessions?.length ?? 0}`,
		`diagnostics: ${health?.diagnostics?.enabled ? valueOrDash(health.diagnostics.path) : "disabled"}`,
		`runtime source: ${status.runtimeSourceReferencePath}`,
		`info: ${status.serviceInfoPath}`,
		`desired info: ${status.desiredRuntimeIdentityPath}`,
		`log: ${status.logPath}`,
	]
	return lines.join("\n")
}
