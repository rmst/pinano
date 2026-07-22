export function parseJson(text, fallback = undefined) {
	if (text === null || text === undefined) return fallback
	try {
		return JSON.parse(String(text))
	} catch {
		return fallback
	}
}

let lastTimestampMs = 0

export function nowIso() {
	const now = Date.now()
	lastTimestampMs = Math.max(now, lastTimestampMs + 1)
	return new Date(lastTimestampMs).toISOString()
}
