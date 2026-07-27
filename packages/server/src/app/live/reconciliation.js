import { sessionCursorGenerationChanged } from "../../../../protocol/src/session-cursor.js"

export const DEFAULT_BACKGROUND_RECONCILE_INTERVAL_MS = 20_000

const numberCursorAdvanced = (next, current) =>
	typeof next === "number" && (typeof current === "number" ? next > current : next > 0)

const optionalValue = (value) => value ?? ""

const currentModelRequestStartedAt = (value) => value?.currentModelRequest?.startedAt ?? value?.currentModelRequestStartedAt ?? ""

const pendingToolCallCount = (snapshot) => {
	if (Array.isArray(snapshot?.pendingToolCallDetails)) return snapshot.pendingToolCallDetails.length
	if (Array.isArray(snapshot?.pendingToolCalls)) return snapshot.pendingToolCalls.length
	return Number(snapshot?.pendingToolCalls?.size ?? 0)
}

/**
 * @param {any} status
 * @param {any} snapshot
 */
export function sessionStatusIndicatesSnapshotStale(status, snapshot) {
	if (!status || !snapshot) return false
	if (status.sessionId && snapshot.sessionId && status.sessionId !== snapshot.sessionId) return false
	if (sessionCursorGenerationChanged(status, snapshot)) return true
	if (numberCursorAdvanced(status.seq, snapshot.seq)) return true
	if (numberCursorAdvanced(status.viewEpoch, snapshot.viewEpoch)) return true
	if (typeof status.isStreaming === "boolean" && status.isStreaming !== snapshot.isStreaming) return true
	if (typeof status.pendingToolCallCount === "number" && status.pendingToolCallCount !== pendingToolCallCount(snapshot)) return true
	if (currentModelRequestStartedAt(status) !== currentModelRequestStartedAt(snapshot)) return true
	if (optionalValue(status.agentView?.state ?? status.agentViewState) !== optionalValue(snapshot.agentView?.state)) return true
	if (optionalValue(status.agentView?.updatedAt ?? status.agentViewUpdatedAt) !== optionalValue(snapshot.agentView?.updatedAt)) return true
	return false
}

const localSessionRunning = (session) => session?.runStatus === "running" || session?.runtimeState === "running"

/**
 * @param {any} status
 * @param {any[]} sessions
 */
export function sessionsStatusIndicatesListStale(status, sessions) {
	const rows = Array.isArray(status?.sessions) ? status.sessions : []
	if (!Array.isArray(sessions)) return rows.length > 0
	if (rows.length !== sessions.length) return true
	for (let index = 0; index < rows.length; index++) {
		const statusRow = rows[index]
		const session = sessions[index]
		if (!session || statusRow.id !== session.id) return true
		if (optionalValue(statusRow.cwd) !== optionalValue(session.cwd)) return true
		if (optionalValue(statusRow.initialWd) !== optionalValue(session.initialWd)) return true
		if (optionalValue(statusRow.updatedAt) !== optionalValue(session.updatedAt)) return true
		if (optionalValue(statusRow.deletedAt) !== optionalValue(session.deletedAt)) return true
		if (optionalValue(statusRow.latestRunStartedAt) !== optionalValue(session.latestRunStartedAt)) return true
		if (optionalValue(statusRow.latestRunEndedAt) !== optionalValue(session.latestRunEndedAt)) return true
		if (optionalValue(statusRow.runStatus) !== optionalValue(session.runStatus)) return true
		if (optionalValue(statusRow.runtimeState) !== optionalValue(session.runtimeState)) return true
		if (typeof statusRow.isStreaming === "boolean" && statusRow.isStreaming !== localSessionRunning(session)) return true
		if (optionalValue(statusRow.agentView?.state ?? statusRow.agentViewState) !== optionalValue(session.agentView?.state)) return true
		if (optionalValue(statusRow.agentView?.updatedAt ?? statusRow.agentViewUpdatedAt) !== optionalValue(session.agentView?.updatedAt)) return true
	}
	return false
}

/**
 * Runs a low-frequency reconciliation callback without overlapping calls. Callers own when the reconciler is active; this helper only handles timer lifecycle and backpressure.
 * @param {() => Promise<void> | void} reconcile
 * @param {{ intervalMs?: number, onError?: (err: any) => void, setTimeout?: (callback: () => void, delayMs: number) => any, clearTimeout?: (handle: any) => void }} [options]
 */
export function createBackgroundReconciler(reconcile, options = {}) {
	const intervalMs = Number.isFinite(options.intervalMs)
		? Math.max(1, Number(options.intervalMs))
		: DEFAULT_BACKGROUND_RECONCILE_INTERVAL_MS
	const setTimer = options.setTimeout ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs))
	const clearTimer = options.clearTimeout ?? ((handle) => globalThis.clearTimeout(handle))
	const onError = options.onError ?? (() => {})
	let active = false
	let stopped = false
	let running = false
	let timer = /** @type {any} */ (null)

	const clear = () => {
		if (timer === null) return
		clearTimer(timer)
		timer = null
	}
	const reportError = (err) => {
		try {
			onError(err)
		} catch {}
	}
	const schedule = (delayMs) => {
		if (stopped || !active || timer !== null) return
		timer = setTimer(run, delayMs)
		timer?.unref?.()
	}
	const run = () => {
		timer = null
		if (stopped || !active) return
		if (running) {
			schedule(intervalMs)
			return
		}
		running = true
		Promise.resolve()
			.then(reconcile)
			.catch(reportError)
			.finally(() => {
				running = false
				schedule(intervalMs)
			})
	}

	return {
		start(options = {}) {
			if (stopped) return
			active = true
			schedule(options.immediate === true ? 0 : intervalMs)
		},
		trigger() {
			if (stopped || !active) return
			clear()
			schedule(0)
		},
		stop() {
			active = false
			clear()
		},
		dispose() {
			stopped = true
			active = false
			clear()
		},
		isActive() {
			return active && !stopped
		},
	}
}
