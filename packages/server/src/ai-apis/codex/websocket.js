// Codex Responses WebSocket transport.
//
// Adapted from Pi's openai-codex-responses transport:
// https://github.com/earendil-works/pi

import { createHash } from "node:crypto"

import {
	WEBSOCKET_RESPONSE_CREATE_BODY_KIND,
	finishHttpAttempt,
	recordHttpResponse,
	recordStreamEvent,
	startHttpAttempt,
	updateHttpAttemptRequestBody,
} from "../model-io-log.js"
import { registerModelSessionResourceCleanup } from "../session-resources.js"
import { convertResponsesMessages, processResponsesStream } from "./responses-shared.js"

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000
const SESSION_CACHE_TTL_MS = 5 * 60_000
const SESSION_MAX_CONNECTION_AGE_MS = 55 * 60_000

const websocketConnections = new Map()
const websocketFallbacks = new Map()

class CodexWebSocketProtocolError extends Error {
	constructor(message, options = {}) {
		super(message)
		this.name = "CodexWebSocketProtocolError"
		this.codexWebSocketProtocolError = true
		if (options.payload !== undefined) this.payload = options.payload
		if (options.cause !== undefined) this.cause = options.cause
	}
}

class CodexWebSocketCloseError extends Error {
	constructor(message, options = {}) {
		super(message)
		this.name = "CodexWebSocketCloseError"
		this.code = options.code
		this.reason = options.reason
		this.wasClean = options.wasClean
	}
}

function configuredTimeoutMs(value, fallback) {
	if (value === false || value === null) return 0
	const timeout = Number(value ?? fallback)
	return Number.isFinite(timeout) && timeout > 0 ? timeout : 0
}

export function codexWebSocketConnectTimeoutMs(value) {
	return configuredTimeoutMs(value, DEFAULT_CONNECT_TIMEOUT_MS)
}

function headersRecord(headers) {
	return Object.fromEntries([...headers.entries()])
}

export function codexWebSocketConnectionIdentity(url, headers) {
	const headerText = JSON.stringify([...headers.entries()].sort(([a], [b]) => a.localeCompare(b)))
	return `${url}\0${createHash("sha256").update(headerText).digest("hex")}`
}

function sessionResourceMatches(key, sessionId) {
	return key === sessionId || key.startsWith(`${sessionId}:`)
}

function closeSocket(socket, code = 1000, reason = "done") {
	try {
		socket.close(code, reason)
	} catch {}
}

function closeEntry(entry, reason) {
	if (entry.idleTimer) clearTimeout(entry.idleTimer)
	entry.idleTimer = undefined
	entry.continuation = undefined
	closeSocket(entry.socket, 1000, reason)
}

export function closeCodexWebSocketSessions(sessionId = undefined) {
	for (const [key, entry] of websocketConnections) {
		if (sessionId !== undefined && !sessionResourceMatches(key, sessionId)) continue
		closeEntry(entry, "session_closed")
		websocketConnections.delete(key)
	}
	for (const key of websocketFallbacks.keys()) {
		if (sessionId === undefined || sessionResourceMatches(key, sessionId)) websocketFallbacks.delete(key)
	}
}

registerModelSessionResourceCleanup(closeCodexWebSocketSessions)

export function codexWebSocketFallbackActive(sessionId, identity) {
	if (!sessionId) return false
	const fallbackIdentity = websocketFallbacks.get(sessionId)
	if (fallbackIdentity === undefined) return false
	if (fallbackIdentity === identity) return true
	websocketFallbacks.delete(sessionId)
	return false
}

export function disableCodexWebSocketForSession(sessionId, identity) {
	if (!sessionId) return
	websocketFallbacks.set(sessionId, identity)
	const entry = websocketConnections.get(sessionId)
	if (entry?.identity !== identity) return
	closeEntry(entry, "sse_fallback")
	websocketConnections.delete(sessionId)
}

export function isCodexWebSocketProtocolError(error) {
	return error?.codexWebSocketProtocolError === true
}

function socketReady(socket) {
	return typeof socket?.readyState !== "number" || socket.readyState === 1
}

function socketExpired(entry) {
	return Date.now() - entry.createdAt >= SESSION_MAX_CONNECTION_AGE_MS
}

function scheduleExpiry(sessionId, entry) {
	if (entry.idleTimer) clearTimeout(entry.idleTimer)
	entry.idleTimer = setTimeout(() => {
		if (entry.busy || websocketConnections.get(sessionId) !== entry) return
		closeEntry(entry, "idle_timeout")
		websocketConnections.delete(sessionId)
	}, SESSION_CACHE_TTL_MS)
	entry.idleTimer.unref?.()
}

function webSocketError(event) {
	if (event instanceof Error) return event
	if (event && typeof event === "object") {
		if (typeof event.message === "string" && event.message) return new Error(event.message)
		if (event.error instanceof Error) return event.error
		if (typeof event.error?.message === "string" && event.error.message) return new Error(event.error.message)
	}
	return new Error("WebSocket error")
}

function webSocketCloseError(event) {
	if (!event || typeof event !== "object") return new CodexWebSocketCloseError("WebSocket closed")
	const code = typeof event.code === "number" ? event.code : undefined
	const reason = typeof event.reason === "string" && event.reason ? event.reason : undefined
	const wasClean = typeof event.wasClean === "boolean" ? event.wasClean : undefined
	const message = [
		"WebSocket closed",
		code === undefined ? "" : String(code),
		reason ?? (code === 1009 ? "message too big" : ""),
	].filter(Boolean).join(" ")
	return new CodexWebSocketCloseError(message, { code, reason, wasClean })
}

async function connectWebSocket(url, headers, signal, timeoutMs, WebSocketConstructor) {
	const Constructor = WebSocketConstructor ?? globalThis.WebSocket
	if (typeof Constructor !== "function") throw new Error("WebSocket transport is not available in this runtime")
	if (signal?.aborted) throw new Error("Request was aborted")

	return await new Promise((resolve, reject) => {
		let settled = false
		let timer
		let socket
		const cleanup = () => {
			if (timer) clearTimeout(timer)
			timer = undefined
			socket?.removeEventListener("open", onOpen)
			socket?.removeEventListener("error", onError)
			socket?.removeEventListener("close", onClose)
			signal?.removeEventListener("abort", onAbort)
		}
		const fail = (error, closeReason = undefined) => {
			if (settled) return
			settled = true
			cleanup()
			if (closeReason && socket) closeSocket(socket, 1000, closeReason)
			reject(error)
		}
		const onOpen = () => {
			if (settled) return
			settled = true
			cleanup()
			resolve(socket)
		}
		const onError = (event) => fail(webSocketError(event), "connect_error")
		const onClose = (event) => fail(webSocketCloseError(event))
		const onAbort = () => fail(new Error("Request was aborted"), "aborted")

		try {
			socket = new Constructor(url, { headers: headersRecord(headers) })
		} catch (error) {
			fail(error instanceof Error ? error : new Error(String(error)))
			return
		}

		socket.addEventListener("open", onOpen)
		socket.addEventListener("error", onError)
		socket.addEventListener("close", onClose)
		signal?.addEventListener("abort", onAbort, { once: true })
		if (timeoutMs > 0) {
			timer = setTimeout(
				() => fail(new Error(`WebSocket connect timeout after ${timeoutMs}ms`), "connect_timeout"),
				timeoutMs,
			)
			timer.unref?.()
		}
		if (signal?.aborted) onAbort()
	})
}

async function acquireWebSocket({
	url,
	headers,
	identity,
	sessionId,
	signal,
	connectTimeoutMs,
	WebSocketConstructor,
}) {
	if (!sessionId) {
		const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs, WebSocketConstructor)
		return {
			socket,
			reused: false,
			release: (reason = "done") => closeSocket(socket, 1000, reason),
		}
	}

	let cached = websocketConnections.get(sessionId)
	if (cached && cached.identity !== identity) {
		websocketConnections.delete(sessionId)
		if (!cached.busy) closeEntry(cached, "connection_identity_changed")
		cached = undefined
	}

	if (cached) {
		if (cached.idleTimer) clearTimeout(cached.idleTimer)
		cached.idleTimer = undefined
		if (!cached.busy && socketExpired(cached)) {
			closeEntry(cached, "connection_age_limit")
			websocketConnections.delete(sessionId)
			cached = undefined
		} else if (!cached.busy && socketReady(cached.socket)) {
			cached.busy = true
			return {
				socket: cached.socket,
				entry: cached,
				reused: true,
				release: (reason = undefined) => {
					if (reason || !socketReady(cached.socket) || websocketConnections.get(sessionId) !== cached) {
						closeEntry(cached, reason ?? "closed")
						if (websocketConnections.get(sessionId) === cached) websocketConnections.delete(sessionId)
						return
					}
					cached.busy = false
					scheduleExpiry(sessionId, cached)
				},
			}
		} else if (!cached.busy) {
			closeEntry(cached, "closed")
			websocketConnections.delete(sessionId)
			cached = undefined
		}
	}

	if (cached?.busy) {
		const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs, WebSocketConstructor)
		return {
			socket,
			reused: false,
			release: (reason = "done") => closeSocket(socket, 1000, reason),
		}
	}

	const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs, WebSocketConstructor)
	const entry = {
		socket,
		identity,
		busy: true,
		createdAt: Date.now(),
		idleTimer: undefined,
		continuation: undefined,
	}
	websocketConnections.set(sessionId, entry)
	return {
		socket,
		entry,
		reused: false,
		release: (reason = undefined) => {
			if (reason || !socketReady(entry.socket) || websocketConnections.get(sessionId) !== entry) {
				closeEntry(entry, reason ?? "closed")
				if (websocketConnections.get(sessionId) === entry) websocketConnections.delete(sessionId)
				return
			}
			entry.busy = false
			scheduleExpiry(sessionId, entry)
		},
	}
}

async function decodeWebSocketData(data) {
	if (typeof data === "string") return data
	if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data))
	if (ArrayBuffer.isView(data)) {
		return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
	}
	if (data && typeof data === "object" && typeof data.arrayBuffer === "function") {
		return new TextDecoder().decode(new Uint8Array(await data.arrayBuffer()))
	}
	throw new CodexWebSocketProtocolError("Unsupported Codex WebSocket message data", { payload: data })
}

function completionEvent(event) {
	return event?.type === "response.completed"
		|| event?.type === "response.done"
		|| event?.type === "response.incomplete"
}

async function* parseWebSocket(socket, {
	signal,
	firstEventTimeoutMs,
	eventInactivityTimeoutMs,
	onRawEvent,
}) {
	const queue = []
	let waiting
	let failed
	let closed = false
	let sawEvent = false
	let sawCompletion = false
	const wake = () => {
		if (!waiting) return
		const resolve = waiting
		waiting = undefined
		resolve()
	}
	const onMessage = (event) => {
		if (!event || typeof event !== "object" || !("data" in event)) return
		queue.push(event.data)
		wake()
	}
	const onError = (event) => {
		failed = webSocketError(event)
		wake()
	}
	const onClose = (event) => {
		closed = true
		if (!sawCompletion && !failed) failed = webSocketCloseError(event)
		wake()
	}
	const onAbort = () => {
		failed = new Error("Request was aborted")
		wake()
	}

	socket.addEventListener("message", onMessage)
	socket.addEventListener("error", onError)
	socket.addEventListener("close", onClose)
	signal?.addEventListener("abort", onAbort, { once: true })

	try {
		while (true) {
			if (signal?.aborted) throw new Error("Request was aborted")
			if (queue.length > 0) {
				const text = await decodeWebSocketData(queue.shift())
				onRawEvent?.({ data: text })
				let event
				try {
					event = JSON.parse(text)
				} catch (cause) {
					throw new CodexWebSocketProtocolError(`Invalid Codex WebSocket JSON: ${cause instanceof Error ? cause.message : String(cause)}`, {
						payload: text,
						cause,
					})
				}
				sawEvent = true
				if (completionEvent(event)) sawCompletion = true
				yield event
				if (sawCompletion) return
				continue
			}
			if (failed) throw failed
			if (closed) {
				if (sawCompletion) return
				throw new CodexWebSocketCloseError("WebSocket closed before response.completed")
			}

			const timeoutMs = sawEvent ? eventInactivityTimeoutMs : firstEventTimeoutMs
			let timer
			await new Promise((resolve, reject) => {
				waiting = resolve
				if (timeoutMs > 0) {
					timer = setTimeout(() => {
						waiting = undefined
						const error = new Error(
							sawEvent
								? `No Codex WebSocket event received within ${timeoutMs}ms`
								: `No first Codex WebSocket event received within ${timeoutMs}ms`,
						)
						closeSocket(socket, 1000, "event_timeout")
						reject(error)
					}, timeoutMs)
					timer.unref?.()
				}
			}).finally(() => {
				if (timer) clearTimeout(timer)
			})
		}
	} finally {
		socket.removeEventListener("message", onMessage)
		socket.removeEventListener("error", onError)
		socket.removeEventListener("close", onClose)
		signal?.removeEventListener("abort", onAbort)
	}
}

function requestWithoutInput(body) {
	const { input: _input, previous_response_id: _previousResponseId, ...rest } = body
	return rest
}

function jsonEqual(a, b) {
	return JSON.stringify(a) === JSON.stringify(b)
}

function continuationInput(body, continuation) {
	if (!jsonEqual(requestWithoutInput(body), requestWithoutInput(continuation.lastRequestBody))) return undefined
	const currentInput = body.input ?? []
	const baseline = [...(continuation.lastRequestBody.input ?? []), ...continuation.lastResponseItems]
	if (currentInput.length < baseline.length) return undefined
	if (!jsonEqual(currentInput.slice(0, baseline.length), baseline)) return undefined
	return currentInput.slice(baseline.length)
}

function cachedRequestBody(entry, body) {
	if (!entry?.continuation) return body
	const input = continuationInput(body, entry.continuation)
	if (input === undefined || !entry.continuation.lastResponseId) {
		entry.continuation = undefined
		return body
	}
	return {
		...body,
		previous_response_id: entry.continuation.lastResponseId,
		input,
	}
}

async function* startOnFirstEvent(events, output, stream, onStart) {
	let started = false
	for await (const event of events) {
		if (!started) {
			started = true
			onStart?.()
			stream.push({ type: "start", partial: output })
		}
		yield event
	}
}

function attemptStatus(signal, error) {
	if (signal?.aborted || error?.message === "Request was aborted") return "aborted"
	return "stream_error"
}

export async function executeCodexWebSocket({
	url,
	headers,
	identity,
	body,
	output,
	stream,
	model,
	context,
	signal,
	sessionId,
	cacheContext,
	mapEvents,
	modelLog,
	attemptIndex,
	onStart,
	connectTimeoutMs,
	firstEventTimeoutMs,
	eventInactivityTimeoutMs,
	WebSocketConstructor,
	pricingContext,
}) {
	const attempt = startHttpAttempt(modelLog, {
		attemptIndex,
		method: "WEBSOCKET",
		url,
		headers,
		body: JSON.stringify({ type: "response.create", ...body }),
		bodyKind: WEBSOCKET_RESPONSE_CREATE_BODY_KIND,
	})
	let acquired
	try {
		acquired = await acquireWebSocket({
			url,
			headers,
			identity,
			sessionId,
			signal,
			connectTimeoutMs,
			WebSocketConstructor,
		})
	} catch (error) {
		finishHttpAttempt(attempt, {
			status: signal?.aborted ? "aborted" : "network_error",
			error: error instanceof Error ? error.message : String(error),
		})
		throw error
	}

	const { socket, entry, reused, release } = acquired
	const requestBody = cacheContext ? cachedRequestBody(entry, body) : body
	const frameJson = JSON.stringify({ type: "response.create", ...requestBody })
	if (requestBody !== body) updateHttpAttemptRequestBody(attempt, { body: frameJson })
	recordHttpResponse(attempt, {
		status: reused ? undefined : 101,
		statusText: reused ? "Reused WebSocket" : "Switching Protocols",
		headers: new Headers(),
	})

	let releaseReason
	try {
		socket.send(frameJson)
		const events = parseWebSocket(socket, {
			signal,
			firstEventTimeoutMs,
			eventInactivityTimeoutMs,
			onRawEvent: (event) => recordStreamEvent(modelLog, attempt, event),
		})
		await processResponsesStream(
			startOnFirstEvent(mapEvents(events), output, stream, onStart),
			output,
			stream,
			model,
			pricingContext,
		)
		if (signal?.aborted) throw new Error("Request was aborted")

		if (cacheContext && entry && output.responseId && output.stopReason !== "error") {
			const responseItems = convertResponsesMessages(model, {
				messages: [output],
				tools: context?.tools ?? [],
			}, { includeSystemPrompt: false })
			entry.continuation = {
				lastRequestBody: body,
				lastResponseId: output.responseId,
				lastResponseItems: responseItems,
			}
		}
		finishHttpAttempt(attempt, { status: "completed" })
	} catch (error) {
		if (entry) entry.continuation = undefined
		releaseReason = signal?.aborted ? "aborted" : "stream_error"
		finishHttpAttempt(attempt, {
			status: attemptStatus(signal, error),
			error: error instanceof Error ? error.message : String(error),
		})
		throw error
	} finally {
		release(releaseReason)
	}
}
