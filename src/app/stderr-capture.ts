// Intercepts writes to `process.stderr` and stores them in a bounded ring buffer
// so the TUI can surface them — the alternate screen buffer used by the TUI
// otherwise wipes stderr output on exit, making JS-level errors invisible.
//
// NOTE: this only captures writes made through `process.stderr` from JS land
// (covers console.error, unhandled-rejection traces, throw-from-async output,
// etc). It does NOT catch raw fd-2 writes from native code — qn's C-level
// `abort()` messages still escape here. Capturing those would require fd
// duplication via dup2, which qn doesn't expose.
//
// The capture forwards each write to the original `stderr.write` so behavior
// outside the TUI (piping, tee, redirection) is unchanged.

const DEFAULT_MAX_LINES = 500

export interface StderrEntry {
	time: number
	text: string
}

export interface StderrCapture {
	size(): number
	entries(): readonly StderrEntry[]
	subscribe(cb: () => void): () => void
	clear(): void
}

/**
 * Install the interceptor on `process.stderr.write`. Idempotent — calling it
 * twice returns the same capture without double-wrapping.
 */
export function installStderrCapture(maxLines = DEFAULT_MAX_LINES): StderrCapture {
	const anyProc = process as any
	if (anyProc.__pinanoStderrCapture) return anyProc.__pinanoStderrCapture as StderrCapture

	const ring: StderrEntry[] = []
	const subscribers = new Set<() => void>()
	let pending = ""

	const pushLine = (text: string) => {
		ring.push({ time: Date.now(), text })
		if (ring.length > maxLines) ring.splice(0, ring.length - maxLines)
		for (const cb of subscribers) {
			try {
				cb()
			} catch {}
		}
	}

	const ingest = (chunk: unknown) => {
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

	const stderr = process.stderr as any
	const orig = stderr.write.bind(stderr)
	stderr.write = function (chunk: unknown, ...rest: unknown[]) {
		try {
			ingest(chunk)
		} catch {}
		return orig(chunk, ...rest)
	}

	const capture: StderrCapture = {
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
	}

	anyProc.__pinanoStderrCapture = capture
	return capture
}
