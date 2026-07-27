import { createHash } from "node:crypto"

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024
const DEFAULT_MAX_BUFFERED_BYTES = 8 * 1024 * 1024
const DEFAULT_HEARTBEAT_MS = 30_000

function headerTokenIncludes(value, token) {
	return String(value || "").split(",").some((part) => part.trim().toLowerCase() === token)
}

function websocketAccept(key) {
	return createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64")
}

function frame(opcode, payload = Buffer.alloc(0)) {
	const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
	if (body.length <= 125) return Buffer.concat([Buffer.from([0x80 | opcode, body.length]), body])
	if (body.length <= 0xffff) {
		const header = Buffer.alloc(4)
		header[0] = 0x80 | opcode
		header[1] = 126
		header.writeUInt16BE(body.length, 2)
		return Buffer.concat([header, body])
	}
	const header = Buffer.alloc(10)
	header[0] = 0x80 | opcode
	header[1] = 127
	header.writeUInt32BE(0, 2)
	header.writeUInt32BE(body.length, 6)
	return Buffer.concat([header, body])
}

function closePayload(code, reason = "") {
	let text = Buffer.from(String(reason))
	if (text.length > 123) {
		text = text.subarray(0, 123)
		while (text.length > 0 && !validUtf8(text)) text = text.subarray(0, text.length - 1)
	}
	const payload = Buffer.alloc(2 + text.length)
	payload.writeUInt16BE(code, 0)
	text.copy(payload, 2)
	return payload
}

function validCloseCode(code) {
	return (
		(code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code))
		|| (code >= 3000 && code <= 4999)
	)
}

function validUtf8(value) {
	for (let i = 0; i < value.length;) {
		const first = value[i++]
		if (first <= 0x7f) continue
		let continuations
		if (first >= 0xc2 && first <= 0xdf) continuations = 1
		else if (first >= 0xe0 && first <= 0xef) continuations = 2
		else if (first >= 0xf0 && first <= 0xf4) continuations = 3
		else return false
		if (i + continuations > value.length) return false
		const second = value[i]
		if (first === 0xe0 && second < 0xa0) return false
		if (first === 0xed && second > 0x9f) return false
		if (first === 0xf0 && second < 0x90) return false
		if (first === 0xf4 && second > 0x8f) return false
		for (let j = 0; j < continuations; j++) {
			const byte = value[i++]
			if (byte < 0x80 || byte > 0xbf) return false
		}
	}
	return true
}

export function rejectWebSocketUpgrade(socket, status = 400, message = "Bad Request") {
	if (socket.destroyed) return
	const body = `${message}\n`
	try {
		socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
	} catch {
		socket.destroy()
	}
}

/**
 * Accept a WebSocket over a Node-compatible HTTP upgrade socket. This intentionally implements only RFC 6455 framing; application protocol and authorization live above it.
 */
export function acceptWebSocket(incoming, socket, head, options = {}) {
	const key = incoming.headers?.["sec-websocket-key"]
	if (
		incoming.method !== "GET"
		|| !headerTokenIncludes(incoming.headers?.upgrade, "websocket")
		|| !headerTokenIncludes(incoming.headers?.connection, "upgrade")
		|| incoming.headers?.["sec-websocket-version"] !== "13"
		|| typeof key !== "string"
		|| Buffer.from(key, "base64").length !== 16
	) {
		rejectWebSocketUpgrade(socket, 400, "Invalid WebSocket upgrade")
		return undefined
	}

	const maxMessageBytes = Number.isSafeInteger(options.maxMessageBytes) ? Math.max(1, options.maxMessageBytes) : DEFAULT_MAX_MESSAGE_BYTES
	const maxBufferedBytes = Number.isSafeInteger(options.maxBufferedBytes) ? Math.max(1024, options.maxBufferedBytes) : DEFAULT_MAX_BUFFERED_BYTES
	const heartbeatMs = Number.isSafeInteger(options.heartbeatMs) ? Math.max(0, options.heartbeatMs) : DEFAULT_HEARTBEAT_MS
	let input = Buffer.alloc(0)
	let fragmentOpcode = 0
	let fragments = []
	let fragmentBytes = 0
	let closed = false
	let closeSent = false
	let heartbeatTimer
	let awaitingPong = false
	const decoder = new TextDecoder()
	const reportError = (err) => {
		try { options.onError?.(err) } catch {}
	}

	const write = (value, allowOverflow = false) => {
		if (closed || socket.destroyed) return false
		if (!allowOverflow && (socket.writableLength ?? 0) + value.length > maxBufferedBytes) {
			connection.close(1013, "Client is too slow")
			return false
		}
		try {
			socket.write(value)
			return true
		} catch (err) {
			fail(err)
			return false
		}
	}
	const finish = (code = 1006, reason = "") => {
		if (closed) return
		closed = true
		if (heartbeatTimer) clearInterval(heartbeatTimer)
		input = Buffer.alloc(0)
		fragments = []
		try { options.onClose?.(code, reason) } catch (err) { reportError(err) }
	}
	const fail = (err) => {
		if (closed) return
		if (err?.code !== "ECONNRESET" && err?.code !== "EPIPE") reportError(err)
		finish(1006, err?.message ?? String(err))
		try { socket.destroy() } catch {}
	}
	const protocolError = (code, reason) => {
		connection.close(code, reason)
	}
	const deliver = (opcode, payload) => {
		if (payload.length > maxMessageBytes) return protocolError(1009, "Message too large")
		if (opcode !== 0x1) return protocolError(1003, "Binary messages are not supported")
		if (!validUtf8(payload)) return protocolError(1007, "Invalid UTF-8")
		try {
			options.onMessage?.(decoder.decode(payload), connection)
		} catch (err) {
			reportError(err)
			connection.close(1011, "WebSocket handler failed")
		}
	}
	const handleFrame = (fin, opcode, payload) => {
		if (opcode >= 0x8) {
			if (!fin || payload.length > 125) return protocolError(1002, "Invalid control frame")
			if (opcode === 0x8) {
				if (payload.length === 1) return protocolError(1002, "Invalid close frame")
				const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005
				if (payload.length >= 2 && !validCloseCode(code)) return protocolError(1002, "Invalid close code")
				const reasonBytes = payload.subarray(2)
				if (!validUtf8(reasonBytes)) return protocolError(1007, "Invalid close reason")
				const reason = decoder.decode(reasonBytes)
				if (!closeSent) write(frame(0x8, payload))
				closeSent = true
				try { socket.end() } catch {}
				finish(code, reason)
				return
			}
			if (opcode === 0x9) return void write(frame(0xa, payload))
			if (opcode === 0xa) {
				awaitingPong = false
				return
			}
			return protocolError(1002, "Unknown control frame")
		}
		if (opcode === 0x0) {
			if (!fragmentOpcode) return protocolError(1002, "Unexpected continuation")
			fragments.push(payload)
			fragmentBytes += payload.length
			if (fragmentBytes > maxMessageBytes) return protocolError(1009, "Message too large")
			if (fin) {
				const completeOpcode = fragmentOpcode
				const complete = Buffer.concat(fragments, fragmentBytes)
				fragmentOpcode = 0
				fragments = []
				fragmentBytes = 0
				deliver(completeOpcode, complete)
			}
			return
		}
		if (opcode !== 0x1 && opcode !== 0x2) return protocolError(1002, "Unknown data frame")
		if (fragmentOpcode) return protocolError(1002, "Interleaved fragmented message")
		if (fin) return deliver(opcode, payload)
		fragmentOpcode = opcode
		fragments = [payload]
		fragmentBytes = payload.length
		if (fragmentBytes > maxMessageBytes) protocolError(1009, "Message too large")
	}
	const parse = (chunk) => {
		if (closed) return
		input = input.length ? Buffer.concat([input, chunk]) : Buffer.from(chunk)
		while (!closed && input.length >= 2) {
			const first = input[0]
			const second = input[1]
			if ((first & 0x70) !== 0) return protocolError(1002, "Extensions are not supported")
			if ((second & 0x80) === 0) return protocolError(1002, "Client frames must be masked")
			let payloadLength = second & 0x7f
			let offset = 2
			if (payloadLength === 126) {
				if (input.length < 4) return
				payloadLength = input.readUInt16BE(2)
				offset = 4
			} else if (payloadLength === 127) {
				if (input.length < 10) return
				const high = input.readUInt32BE(2)
				const low = input.readUInt32BE(6)
				if (high !== 0 || low > maxMessageBytes) return protocolError(1009, "Message too large")
				payloadLength = low
				offset = 10
			}
			if (payloadLength > maxMessageBytes || input.length < offset + 4 + payloadLength) {
				if (payloadLength > maxMessageBytes) protocolError(1009, "Message too large")
				return
			}
			const mask = input.subarray(offset, offset + 4)
			const payload = Buffer.from(input.subarray(offset + 4, offset + 4 + payloadLength))
			for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]
			input = input.subarray(offset + 4 + payloadLength)
			handleFrame((first & 0x80) !== 0, first & 0x0f, payload)
		}
	}

	const connection = {
		sendText(text) {
			return write(frame(0x1, Buffer.from(String(text))))
		},
		sendJson(value) {
			return connection.sendText(JSON.stringify(value))
		},
		close(code = 1000, reason = "") {
			if (closed) return
			if (!closeSent) {
				closeSent = true
				write(frame(0x8, closePayload(code, reason)), true)
			}
			try { socket.end() } catch {}
			finish(code, reason)
		},
		get closed() {
			return closed
		},
	}

	try {
		socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${websocketAccept(key)}\r\n\r\n`)
		socket.setNoDelay?.(true)
		socket.on("data", parse)
		socket.once("end", () => finish(1006, "Socket ended"))
		socket.once("close", () => finish(1006, "Socket closed"))
		socket.once("error", fail)
		if (head?.length) parse(head)
		socket.resume?.()
		options.onOpen?.(connection)
		if (!closed && heartbeatMs > 0) {
			heartbeatTimer = setInterval(() => {
				if (awaitingPong) return connection.close(1001, "Heartbeat timeout")
				awaitingPong = true
				write(frame(0x9))
			}, heartbeatMs)
			heartbeatTimer.unref?.()
		}
	} catch (err) {
		fail(err)
		return undefined
	}
	return connection
}
