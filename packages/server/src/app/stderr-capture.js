// Intercepts writes to `process.stderr` and stores them in a bounded ring buffer for this TUI client. Think of this as the browser DevTools console for one Pinano frontend process: scoped to this terminal window, ephemeral, and not the detached Pinano service log.
//
// NOTE: this only captures writes made through `process.stderr` from JS land
// (covers console.error, unhandled-rejection traces, throw-from-async output,
// etc). It does NOT catch raw fd-2 writes from native code — qn's C-level
// `abort()` messages still escape here. Capturing those would require fd
// duplication via dup2, which qn doesn't expose.
//
// The capture forwards each write to the original `stderr.write` by default so behavior outside the TUI (piping, tee, redirection) is unchanged. While the TUI owns the terminal, callers should disable forwarding so diagnostics stay in the buffer instead of corrupting the painted terminal surface.

const DEFAULT_MAX_LINES = 500

/**
 * @typedef {object} StderrEntry
 * @property {number} time
 * @property {string} text
 */

/**
 * @typedef {object} StderrCapture
 * @property {() => number} size
 * @property {() => readonly StderrEntry[]} entries
 * @property {(cb: () => void) => () => void} subscribe
 * @property {() => void} clear
 * @property {(text: string) => void} record
 * @property {(enabled: boolean) => void} setForwarding
 * @property {() => boolean} isForwarding
 */

/**
 * Install the interceptor on `process.stderr.write`. Idempotent — calling it
 * twice returns the same capture without double-wrapping.
 *
 * @param {number} [maxLines]
 * @returns {StderrCapture}
 */
export function installStderrCapture(maxLines = DEFAULT_MAX_LINES) {
	const anyProc = /** @type {any} */ (process)
	if (anyProc.__pinanoStderrCapture) return /** @type {StderrCapture} */ (anyProc.__pinanoStderrCapture)

	/** @type {StderrEntry[]} */
	const ring = []
	/** @type {Set<() => void>} */
	const subscribers = new Set()
	let pending = ""
	let forwarding = true

	/** @param {string} text */
	const pushLine = (text) => {
		ring.push({ time: Date.now(), text })
		if (ring.length > maxLines) ring.splice(0, ring.length - maxLines)
		for (const cb of subscribers) {
			try {
				cb()
			} catch {}
		}
	}

	/** @param {unknown} chunk */
	const ingest = (chunk) => {
		const str =
			typeof chunk === "string"
				? chunk
				: chunk instanceof Uint8Array
					? Buffer.from(chunk).toString("utf-8")
					: String(chunk)
		pending += str
		const parts = pending.split("\n")
		pending = parts.pop() ?? ""
		for (const line of parts) if (line) pushLine(line)
	}

	const stderr = /** @type {any} */ (process.stderr)
	const orig = stderr.write.bind(stderr)
	stderr.write = function (/** @type {unknown} */ chunk, /** @type {unknown[]} */ ...rest) {
		try {
			ingest(chunk)
		} catch {}
		if (forwarding) return orig(chunk, ...rest)
		const lastArg = rest[rest.length - 1]
		const callback = typeof lastArg === "function" ? lastArg : undefined
		if (callback) process.nextTick(/** @type {() => void} */ (callback))
		return true
	}

	/** @type {StderrCapture} */
	const capture = {
		size: () => ring.length + (pending ? 1 : 0),
		entries: () => {
			if (!pending) return ring
			return [...ring, { time: Date.now(), text: pending }]
		},
		subscribe: (cb) => {
			subscribers.add(cb)
			return () => subscribers.delete(cb)
		},
		clear: () => {
			ring.length = 0
			pending = ""
			for (const cb of subscribers) {
				try {
					cb()
				} catch {}
			}
		},
		record: (text) => {
			try {
				ingest(`${text}\n`)
			} catch {}
		},
		setForwarding: (enabled) => {
			forwarding = enabled === true
		},
		isForwarding: () => forwarding,
	}

	anyProc.__pinanoStderrCapture = capture
	return capture
}
