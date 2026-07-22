import * as http from "node:http"

export const HOP_BY_HOP_HEADERS = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
])

const NULL_BODY_STATUS = new Set([204, 205, 304])

export function responseBodyAllowed(method, status) {
	return String(method || "GET").toUpperCase() !== "HEAD" && !NULL_BODY_STATUS.has(status)
}

export function proxiedResponse(body, { method, status, statusText, headers }) {
	const cleanStatus = Number.isInteger(status) && status >= 200 && status <= 599 ? status : 502
	return new Response(responseBodyAllowed(method, cleanStatus) ? body : null, {
		status: cleanStatus,
		statusText,
		headers,
	})
}

function incomingMessageBody(message) {
	return new ReadableStream({
		start(controller) {
			let closed = false
			const fail = (err) => {
				if (closed) return
				closed = true
				try {
					controller.error(err)
				} catch {}
			}
			message.on("data", (chunk) => {
				if (closed) return
				try {
					controller.enqueue(chunk)
				} catch (err) {
					fail(err)
					message.destroy?.(err)
				}
			})
			message.on("end", () => {
				if (closed) return
				closed = true
				try {
					controller.close()
				} catch {}
			})
			message.on("error", fail)
		},
		cancel() {
			message.destroy()
		},
	})
}

function bodyAllowed(method) {
	const normalized = String(method || "GET").toUpperCase()
	return normalized !== "GET" && normalized !== "HEAD"
}

function normalizeBodyChunk(chunk) {
	if (chunk === undefined || chunk === null) return undefined
	if (typeof chunk === "string") return chunk
	if (chunk instanceof Uint8Array) return chunk
	if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk)
	if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
	return chunk
}

function waitForDrainOrFinish(stream) {
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			stream.removeListener("drain", onDrain)
			stream.removeListener("error", onError)
			stream.removeListener("close", onClose)
		}
		const onDrain = () => {
			cleanup()
			resolve(true)
		}
		const onError = (err) => {
			cleanup()
			reject(err)
		}
		const onClose = () => {
			cleanup()
			resolve(false)
		}
		stream.once("drain", onDrain)
		stream.once("error", onError)
		stream.once("close", onClose)
	})
}

async function writeBodyChunk(upstream, chunk) {
	const bodyChunk = normalizeBodyChunk(chunk)
	if (bodyChunk === undefined) return
	if (!upstream.write(bodyChunk)) await waitForDrainOrFinish(upstream)
}

async function writeRequestBody(upstream, request, method) {
	if (!bodyAllowed(method) || !request.body) {
		upstream.end()
		return
	}
	const body = request.body
	if (typeof body.getReader === "function") {
		const reader = body.getReader()
		try {
			for (;;) {
				const { done, value } = await reader.read()
				if (done) break
				await writeBodyChunk(upstream, value)
			}
		} finally {
			reader.releaseLock?.()
		}
		upstream.end()
		return
	}
	if (typeof body[Symbol.asyncIterator] === "function") {
		for await (const chunk of body) await writeBodyChunk(upstream, chunk)
		upstream.end()
		return
	}
	await writeBodyChunk(upstream, body)
	upstream.end()
}

export function requestPath(url) {
	const parsed = new URL(url)
	return `${parsed.pathname}${parsed.search}`
}

export async function proxyHttpRequest(request, target, options = {}) {
	const method = request.method || "GET"
	return await new Promise((resolve, reject) => {
		let settled = false
		let responseStarted = false
		const finish = (fn, value) => {
			if (settled) return
			settled = true
			fn(value)
		}
		const upstream = http.request({
			host: target.host,
			port: target.port,
			method,
			path: target.path,
			headers: target.headers,
		}, (upstreamResponse) => {
			responseStarted = true
			try {
				const headers = new Headers()
				for (const [name, value] of Object.entries(upstreamResponse.headers)) {
					if (Array.isArray(value)) for (const item of value) headers.append(name, item)
					else if (value !== undefined) headers.set(name, value)
				}
				const status = upstreamResponse.statusCode ?? 502
				const body = responseBodyAllowed(method, status) ? incomingMessageBody(upstreamResponse) : null
				if (!body) upstreamResponse.on("data", () => {})
				finish(resolve, proxiedResponse(body, {
					method,
					status,
					statusText: upstreamResponse.statusMessage,
					headers: options.responseHeaders ? options.responseHeaders(headers, upstreamResponse) : headers,
				}))
			} catch (err) {
				finish(reject, err)
			}
		})
		upstream.on("error", (err) => {
			if (!responseStarted) finish(reject, err)
		})
		request.signal?.addEventListener("abort", () => upstream.destroy(), { once: true })
		writeRequestBody(upstream, request, method).catch((err) => {
			upstream.destroy(err)
			if (!responseStarted) finish(reject, err)
		})
	})
}
