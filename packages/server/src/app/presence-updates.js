export const DEFAULT_PRESENCE_UPDATE_PAUSE_DELAY_MS = 1000

/** @param {{ visibilityState?: string } | undefined} [documentObject] */
export function browserDocumentIsPresent(documentObject = globalThis.document) {
	return !documentObject || documentObject.visibilityState !== "hidden"
}

/**
 * Coordinates live-update delivery with client presence. The gate never owns authoritative state; callers suspend delivery when absent and must rebase from snapshots/lists when resumed after a suspension.
 * @param {{ onResume: (event: { reason: string, missedUpdates: boolean }) => void | Promise<void>, onSuspend: (event: { reason: string }) => void | Promise<void>, onError?: (err: any) => void }} callbacks
 * @param {{ initialPresent?: boolean, pauseDelayMs?: number, now?: () => number, setTimeout?: (callback: () => void, delayMs: number) => any, clearTimeout?: (handle: any) => void }} [options]
 */
export function createPresenceUpdateGate(callbacks, options = {}) {
	const pauseDelayMs = Number.isFinite(options.pauseDelayMs)
		? Math.max(0, Number(options.pauseDelayMs))
		: DEFAULT_PRESENCE_UPDATE_PAUSE_DELAY_MS
	const now = options.now ?? (() => Date.now())
	const setTimer = options.setTimeout ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs))
	const clearTimer = options.clearTimeout ?? ((handle) => globalThis.clearTimeout(handle))
	const onError = callbacks.onError ?? (() => {})
	let started = false
	let stopped = false
	let present = options.initialPresent !== false
	let suspended = !present
	let pauseTimer = /** @type {any} */ (null)
	let pendingSuspendStartedAt = /** @type {number | undefined} */ (undefined)

	const reportError = (err) => {
		try {
			onError(err)
		} catch {}
	}
	const call = (fn, event) => {
		try {
			Promise.resolve(fn(event)).catch(reportError)
		} catch (err) {
			reportError(err)
		}
	}
	const clearPauseTimer = () => {
		if (pauseTimer === null) return
		clearTimer(pauseTimer)
		pauseTimer = null
	}
	const suspend = (reason) => {
		clearPauseTimer()
		pendingSuspendStartedAt = undefined
		if (stopped || suspended) return
		suspended = true
		call(callbacks.onSuspend, { reason })
	}
	const resume = (reason, options = {}) => {
		clearPauseTimer()
		pendingSuspendStartedAt = undefined
		if (stopped) return
		if (!options.force && !suspended) return
		const missedUpdates = started && suspended
		suspended = false
		call(callbacks.onResume, { reason, missedUpdates })
	}
	const resumeFromDelayedPendingSuspend = (reason) => {
		const startedAt = pendingSuspendStartedAt
		clearPauseTimer()
		pendingSuspendStartedAt = undefined
		if (stopped || suspended || !started || startedAt === undefined) return false
		if (pauseDelayMs <= 0 || now() - startedAt < pauseDelayMs) return false
		call(callbacks.onResume, { reason, missedUpdates: true })
		return true
	}
	const scheduleSuspend = (reason) => {
		clearPauseTimer()
		pendingSuspendStartedAt = now()
		if (pauseDelayMs <= 0) {
			suspend(reason)
			return
		}
		pauseTimer = setTimer(() => {
			pauseTimer = null
			if (!present) suspend(reason)
		}, pauseDelayMs)
		pauseTimer?.unref?.()
	}

	return {
		start() {
			if (started || stopped) return
			started = true
			if (present) resume("initial", { force: true })
			else suspended = true
		},
		setPresent(nextPresent, reason = nextPresent === false ? "absent" : "present") {
			if (stopped) return
			const normalized = nextPresent !== false
			if (present === normalized && !(normalized && suspended)) return
			present = normalized
			if (present) {
				if (!resumeFromDelayedPendingSuspend(reason)) resume(reason)
			}
			else scheduleSuspend(reason)
		},
		suspendNow(reason = "absent") {
			if (stopped) return
			present = false
			suspend(reason)
		},
		stop() {
			stopped = true
			clearPauseTimer()
		},
		isSuspended() {
			return suspended
		},
		allowsLiveUpdates() {
			return started && !stopped && !suspended
		},
	}
}
