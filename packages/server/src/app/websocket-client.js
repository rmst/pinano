import { createHash, randomBytes } from "node:crypto"
import * as net from "node:net"

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000
const DEFAULT_MAX_MESSAGE_BYTES = 8 * 1024 * 1024
const MAX_HANDSHAKE_BYTES = 64 * 1024

function headerTokenIncludes(value, token) {
	return String(value || "").split(",").some((part) => part.trim().toLowerCase() === token)
}

function frame(opcode, value = Buffer.alloc(0)) {
	const payload = Buffer.isBuffer(value) ? value : Buffer.from(value)
	const mask = randomBytes(4)
	let header
	if (payload.length <= 125) header = Buffer.from([0x80 | opcode, 0x80 | payload.length])
	else if (payload.length <= 0xffff) {
		header = Buffer.alloc(4)
		header[0] = 0x80 | opcode
		header[1] = 0x80 | 126
		header.writeUInt16BE(payload.length, 2)
	} else {
		header = Buffer.alloc(10)
		header[0] = 0x80 | opcode
		header[1] = 0x80 | 127
		header.writeUInt32BE(0, 2)
		header.writeUInt32BE(payload.length, 6)
	}
	const masked = Buffer.alloc(payload.length)
	for (let index = 0; index < payload.length; index++) masked[index] = payload[index] ^ mask[index & 3]
	return Buffer.concat([header, mask, masked])
}

function closePayload(code, reason) {
	const chunks = []
	let textBytes = 0
	for (const character of String(reason || "")) {
		const chunk = Buffer.from(character)
		if (textBytes + chunk.length > 123) break
		chunks.push(chunk)
		textBytes += chunk.length
	}
	const text = Buffer.concat(chunks, textBytes)
	const payload = Buffer.alloc(2 + text.length)
	payload.writeUInt16BE(code, 0)
	text.copy(payload, 2)
	return payload
}

/** Minimal browser-compatible WebSocket client for Node-compatible runtimes without a global WebSocket implementation. */
export function createWebSocketClient(value, options = {}) {
	const url = new URL(value)
	if (url.protocol !== "ws:") throw new Error(`Unsupported WebSocket protocol: ${url.protocol}`)
	const key = randomBytes(16).toString("base64")
	const expectedAccept = createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64")
	const maxMessageBytes = Number.isSafeInteger(options.maxMessageBytes) ? Math.max(1, options.maxMessageBytes) : DEFAULT_MAX_MESSAGE_BYTES
	const connectTimeoutMs = Number.isSafeInteger(options.connectTimeoutMs) ? Math.max(0, options.connectTimeoutMs) : DEFAULT_CONNECT_TIMEOUT_MS
	const closeTimeoutMs = Number.isSafeInteger(options.closeTimeoutMs) ? Math.max(0, options.closeTimeoutMs) : DEFAULT_CLOSE_TIMEOUT_MS
	let readyState = 0
	let socket
	let handshake = Buffer.alloc(0)
	let input = Buffer.alloc(0)
	let fragmentOpcode = 0
	let fragments = []
	let fragmentBytes = 0
	let closeSent = false
	let closeCode = 1006
	let closeReason = ""
	let connectTimer
	let closeTimer

	const client = {
		onopen: null,
		onmessage: null,
		onerror: null,
		onclose: null,
		get readyState() {
			return readyState
		},
		send(data) {
			if (readyState !== 1 || !socket) throw new Error("WebSocket is not open")
			socket.write(frame(0x1, Buffer.from(String(data))))
		},
		close(code = 1000, reason = "") {
			if (readyState >= 2) return
			if (readyState === 0) {
				readyState = 2
				socket?.destroy?.()
				finish(code, reason, true)
				return
			}
			readyState = 2
			closeSent = true
			closeCode = code
			closeReason = reason
			socket.write(frame(0x8, closePayload(code, reason)))
			if (closeTimeoutMs > 0) {
				closeTimer = setTimeout(() => fail(new Error("WebSocket close timed out")), closeTimeoutMs)
				closeTimer.unref?.()
			}
		},
	}

	const finish = (code = closeCode, reason = closeReason, wasClean = code !== 1006) => {
		if (readyState === 3) return
		readyState = 3
		if (connectTimer) clearTimeout(connectTimer)
		connectTimer = undefined
		if (closeTimer) clearTimeout(closeTimer)
		closeTimer = undefined
		input = Buffer.alloc(0)
		fragments = []
		try { client.onclose?.({ code, reason, wasClean }) } catch {}
	}
	const fail = (err) => {
		if (readyState === 3) return
		try { client.onerror?.(err instanceof Error ? err : new Error(String(err))) } catch {}
		try { socket?.destroy?.() } catch {}
		finish(1006, err?.message ?? String(err), false)
	}
	const protocolError = (reason) => {
		if (readyState === 1) client.close(1002, reason)
		else fail(new Error(reason))
	}
	const deliver = (opcode, payload) => {
		if (opcode !== 0x1) return protocolError("Binary WebSocket messages are not supported")
		try { client.onmessage?.({ data: new TextDecoder().decode(payload) }) } catch (err) { fail(err) }
	}
	const handleFrame = (fin, opcode, payload) => {
		if (opcode >= 0x8) {
			if (!fin || payload.length > 125) return protocolError("Invalid WebSocket control frame")
			if (opcode === 0x8) {
				if (payload.length === 1) return protocolError("Invalid WebSocket close frame")
				const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000
				const reason = new TextDecoder().decode(payload.subarray(2))
				if (!closeSent && socket) socket.write(frame(0x8, payload))
				closeSent = true
				closeCode = code
				closeReason = reason
				readyState = 2
				socket?.end?.()
				return
			}
			if (opcode === 0x9) return void socket?.write?.(frame(0xa, payload))
			if (opcode === 0xa) return
			return protocolError("Unknown WebSocket control frame")
		}
		if (readyState === 2) return
		if (opcode === 0x0) {
			if (!fragmentOpcode) return protocolError("Unexpected WebSocket continuation")
			fragments.push(payload)
			fragmentBytes += payload.length
			if (fragmentBytes > maxMessageBytes) return protocolError("WebSocket message is too large")
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
		if (opcode !== 0x1 && opcode !== 0x2) return protocolError("Unknown WebSocket frame")
		if (fragmentOpcode) return protocolError("Interleaved WebSocket fragments")
		if (fin) return deliver(opcode, payload)
		fragmentOpcode = opcode
		fragments = [payload]
		fragmentBytes = payload.length
	}
	const parse = (chunk) => {
		if (readyState === 3) return
		input = input.length ? Buffer.concat([input, chunk]) : Buffer.from(chunk)
		while (readyState !== 3 && input.length >= 2) {
			const first = input[0]
			const second = input[1]
			if ((first & 0x70) !== 0 || (second & 0x80) !== 0) return protocolError("Invalid WebSocket frame")
			let length = second & 0x7f
			let offset = 2
			if (length === 126) {
				if (input.length < 4) return
				length = input.readUInt16BE(2)
				offset = 4
			} else if (length === 127) {
				if (input.length < 10) return
				if (input.readUInt32BE(2) !== 0) return protocolError("WebSocket message is too large")
				length = input.readUInt32BE(6)
				offset = 10
			}
			if (length > maxMessageBytes) return protocolError("WebSocket message is too large")
			if (input.length < offset + length) return
			const payload = input.subarray(offset, offset + length)
			input = input.subarray(offset + length)
			handleFrame((first & 0x80) !== 0, first & 0x0f, payload)
		}
	}
	const handleHandshake = (chunk) => {
		handshake = handshake.length ? Buffer.concat([handshake, chunk]) : Buffer.from(chunk)
		if (handshake.length > MAX_HANDSHAKE_BYTES) return fail(new Error("WebSocket upgrade response is too large"))
		const boundary = handshake.indexOf("\r\n\r\n")
		if (boundary < 0) return
		const lines = new TextDecoder().decode(handshake.subarray(0, boundary)).split("\r\n")
		const headers = new Map(lines.slice(1).map((line) => {
			const separator = line.indexOf(":")
			return separator < 0
				? [line.toLowerCase(), ""]
				: [line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim()]
		}))
		if (
			!/^HTTP\/1\.[01] 101(?: |$)/.test(lines[0] || "")
			|| !headerTokenIncludes(headers.get("upgrade"), "websocket")
			|| !headerTokenIncludes(headers.get("connection"), "upgrade")
			|| headers.get("sec-websocket-accept") !== expectedAccept
		) {
			return fail(new Error("Invalid WebSocket upgrade response"))
		}
		const head = handshake.subarray(boundary + 4)
		handshake = Buffer.alloc(0)
		if (connectTimer) clearTimeout(connectTimer)
		connectTimer = undefined
		readyState = 1
		try { client.onopen?.({}) } catch (err) { fail(err) }
		if (readyState === 1 && head.length) parse(head)
	}
	const handleData = (chunk) => readyState === 0 ? handleHandshake(chunk) : parse(chunk)
	const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname
	socket = net.createConnection(Number(url.port || 80), hostname, () => {
		socket.write([
			`GET ${url.pathname}${url.search} HTTP/1.1`,
			`Host: ${url.host}`,
			"Connection: Upgrade",
			"Upgrade: websocket",
			"Sec-WebSocket-Version: 13",
			`Sec-WebSocket-Key: ${key}`,
			"",
			"",
		].join("\r\n"))
	})
	socket.on("data", handleData)
	socket.once("error", fail)
	socket.once("end", () => finish(closeCode, closeReason, closeCode !== 1006))
	socket.once("close", () => finish(closeCode, closeReason, closeCode !== 1006))
	if (connectTimeoutMs > 0) {
		connectTimer = setTimeout(() => fail(new Error(`WebSocket connection timed out after ${connectTimeoutMs}ms`)), connectTimeoutMs)
		connectTimer.unref?.()
	}
	return client
}
