// Parse a Server-Sent-Events response body into JSON-decoded `data:` events.
// Yields each parsed JSON payload. Skips heartbeat/comment lines (starting
// with `:`) and the OpenAI sentinel `data: [DONE]`.
//
// Works against both Node and qn: we keep a byte buffer and only decode
// complete events (delimited by ASCII `\n\n` / `\r\n\r\n`) so split
// multi-byte UTF-8 sequences never straddle a decode call. qn's TextDecoder
// rejects `{ stream: true }`, hence the byte-level boundary search.

const DECODER = new TextDecoder("utf-8")
const LF = 0x0a
const CR = 0x0d

export async function* parseSSE(stream) {
	const reader = stream.getReader()
	let buffer = new Uint8Array(0)
	try {
		while (true) {
			const { value, done } = await reader.read()
			if (done) break
			buffer = appendBytes(buffer, value)

			while (true) {
				const sep = findEventBoundary(buffer)
				if (sep < 0) break
				const eventBytes = buffer.subarray(0, sep.index)
				buffer = buffer.subarray(sep.index + sep.length)
				const rawEvent = DECODER.decode(eventBytes)
				const data = extractData(rawEvent)
				if (data === null || data === "[DONE]") continue
				try {
					yield JSON.parse(data)
				} catch {
					// Some servers emit non-JSON heartbeat data; ignore it.
				}
			}
		}

		// Flush any trailing event without a terminating blank line.
		if (buffer.length > 0) {
			const tail = DECODER.decode(buffer)
			if (tail.trim().length > 0) {
				const data = extractData(tail)
				if (data && data !== "[DONE]") {
					try {
						yield JSON.parse(data)
					} catch {}
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
