// Parse a Server-Sent-Events response body into JSON-decoded `data:` events.
// Yields each parsed JSON payload. Skips heartbeat/comment lines (starting
// with `:`) and the OpenAI sentinel `data: [DONE]`.
//
// Works against both Node and qn: we keep a byte buffer and only decode
// complete events (delimited by ASCII `\n\n` / `\r\n\r\n`) so split
// multi-byte UTF-8 sequences never straddle a decode call.

const DECODER = new TextDecoder("utf-8")
const LF = 0x0a
const CR = 0x0d

export class StreamInactivityTimeoutError extends Error {
	constructor(timeoutMs) {
		super(`No SSE data received within ${timeoutMs}ms`)
		this.name = "StreamInactivityTimeoutError"
		this.timeoutMs = timeoutMs
	}
}

async function readWithInactivityTimeout(reader, timeoutMs) {
	if (!timeoutMs) return reader.read()
	let timer
	try {
		return await Promise.race([
			reader.read(),
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new StreamInactivityTimeoutError(timeoutMs)), timeoutMs)
			}),
		])
	} finally {
		if (timer) clearTimeout(timer)
	}
}

export async function* parseSSE(stream, options = {}) {
	const reader = stream.getReader()
	const inactivityTimeoutMs = Number(options.inactivityTimeoutMs ?? 0)
	let buffer = new Uint8Array(0)
	try {
		while (true) {
			let chunk
			try {
				chunk = await readWithInactivityTimeout(reader, inactivityTimeoutMs > 0 ? inactivityTimeoutMs : 0)
			} catch (error) {
				if (error?.name === "StreamInactivityTimeoutError") {
					try { await reader.cancel(error) } catch {}
				}
				throw error
			}
			const { value, done } = chunk
			if (done) break
			buffer = appendBytes(buffer, value)

			while (true) {
				const sep = findEventBoundary(buffer)
				if (sep < 0) break
				const eventBytes = buffer.subarray(0, sep.index)
				buffer = buffer.subarray(sep.index + sep.length)
				const rawEvent = DECODER.decode(eventBytes)
				const data = extractData(rawEvent)
				if (data === null || data === "[DONE]") {
					options.onEvent?.({ rawEvent, data })
					continue
				}
				try {
					const parsed = JSON.parse(data)
					options.onEvent?.({ rawEvent, data, parsed })
					yield parsed
				} catch {
					options.onEvent?.({ rawEvent, data })
					// Some servers emit non-JSON heartbeat data; ignore it.
				}
			}
		}

		// Flush any trailing event without a terminating blank line.
		if (buffer.length > 0) {
			const tail = DECODER.decode(buffer)
			if (tail.trim().length > 0) {
				const data = extractData(tail)
				if (data === "[DONE]") {
					options.onEvent?.({ rawEvent: tail, data })
				} else if (data) {
					try {
						const parsed = JSON.parse(data)
						options.onEvent?.({ rawEvent: tail, data, parsed })
						yield parsed
					} catch {
						options.onEvent?.({ rawEvent: tail, data })
					}
				}
			}
		}
	} finally {
		try {
			reader.releaseLock()
		} catch {}
	}
}

function appendBytes(a, b) {
	if (a.length === 0) return b
	const out = new Uint8Array(a.length + b.length)
	out.set(a, 0)
	out.set(b, a.length)
	return out
}

function findEventBoundary(buffer) {
	for (let i = 0; i < buffer.length - 1; i++) {
		if (buffer[i] === LF && buffer[i + 1] === LF) return { index: i, length: 2 }
		if (
			buffer[i] === CR &&
			buffer[i + 1] === LF &&
			i + 3 < buffer.length &&
			buffer[i + 2] === CR &&
			buffer[i + 3] === LF
		) {
			return { index: i, length: 4 }
		}
	}
	return -1
}

function extractData(rawEvent) {
	const lines = rawEvent.split(/\r?\n/)
	const dataParts = []
	for (const line of lines) {
		if (line.startsWith(":")) continue
		if (line.startsWith("data:")) {
			const v = line.slice(5)
			dataParts.push(v.startsWith(" ") ? v.slice(1) : v)
		}
	}
	if (dataParts.length === 0) return null
	return dataParts.join("\n")
}
