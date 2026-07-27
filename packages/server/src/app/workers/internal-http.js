import { randomUUID } from "node:crypto"
import * as http from "node:http"

import { INTERNAL_API_BASE_URL_ENV, INTERNAL_API_TOKEN_ENV } from "../../../../protocol/src/internal-api-env.js"

const MAX_INTERNAL_HTTP_BODY_BYTES = 1024 * 1024

function normalizeHeaders(headers = {}) {
	return Object.fromEntries(Object.entries(headers)
		.filter(([name]) => name.toLowerCase() !== "authorization")
		.map(([name, value]) => [name, Array.isArray(value) ? value.join(", ") : String(value ?? "")]))
}

function requestPath(incoming) {
	const url = new URL(incoming.url || "/", "http://127.0.0.1")
	return `${url.pathname}${url.search}`
}

function requestToken(incoming) {
	const value = incoming.headers.authorization
	if (Array.isArray(value)) return value[0]?.match(/^\s*Bearer\s+(.+?)\s*$/i)?.[1] || ""
	return String(value || "").match(/^\s*Bearer\s+(.+?)\s*$/i)?.[1] || ""
}

function bodyBufferFromResponse(response = {}) {
	if (typeof response.bodyBase64 === "string") return Buffer.from(response.bodyBase64, "base64")
	if (typeof response.body === "string") return Buffer.from(response.body, "utf-8")
	return Buffer.alloc(0)
}

function writeBridgeResponse(outgoing, response = {}) {
	const status = Number.isInteger(response.status) ? response.status : 200
	const headers = response.headers && typeof response.headers === "object" ? response.headers : {}
	const body = bodyBufferFromResponse(response)
	for (const [name, value] of Object.entries(headers)) outgoing.setHeader(name, String(value))
	if (!outgoing.hasHeader("content-length")) outgoing.setHeader("content-length", String(body.length))
	outgoing.writeHead(status)
	outgoing.end(body)
}

function internalErrorResponse(message, status = 500) {
	return internalHttpJsonResponse({ error: message }, status)
}

function readRequestBody(incoming) {
	return new Promise((resolve, reject) => {
		const chunks = []
		let bytes = 0
		incoming.on("data", (chunk) => {
			bytes += chunk.length
			if (bytes > MAX_INTERNAL_HTTP_BODY_BYTES) {
				reject(Object.assign(new Error("Internal API request body is too large"), { status: 413 }))
				incoming.destroy()
				return
			}
			chunks.push(chunk)
		})
		incoming.on("end", () => resolve(Buffer.concat(chunks)))
		incoming.on("error", reject)
	})
}

export function internalHttpJsonResponse(data, status = 200, headers = {}) {
	const body = Buffer.from(JSON.stringify(data), "utf-8")
	return {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			...headers,
		},
		bodyBase64: body.toString("base64"),
	}
}

export function internalHttpRequestBodyBuffer(request = {}) {
	if (typeof request.bodyBase64 === "string") return Buffer.from(request.bodyBase64, "base64")
	if (typeof request.body === "string") return Buffer.from(request.body, "utf-8")
	return Buffer.alloc(0)
}

export function internalHttpRequestBodyText(request = {}) {
	return internalHttpRequestBodyBuffer(request).toString("utf-8")
}

export async function startWorkerInternalHttpBridge(options) {
	const token = randomUUID()
	const server = http.createServer(async (incoming, outgoing) => {
		try {
			if (requestToken(incoming) !== token) {
				writeBridgeResponse(outgoing, internalErrorResponse("Unauthorized", 401))
				return
			}
			const body = await readRequestBody(incoming)
			const response = await options.request({
				method: incoming.method || "GET",
				path: requestPath(incoming),
				headers: normalizeHeaders(incoming.headers),
				bodyBase64: body.toString("base64"),
			})
			writeBridgeResponse(outgoing, response)
		} catch (err) {
			writeBridgeResponse(outgoing, internalErrorResponse(err?.message ?? String(err), err?.status ?? 500))
		}
	})
	await new Promise((resolve, reject) => {
		const cleanup = () => server.off("error", onError)
		const onError = (err) => {
			cleanup()
			reject(err)
		}
		server.once("error", onError)
		server.listen(0, "127.0.0.1", () => {
			cleanup()
			resolve(undefined)
		})
	})
	const address = server.address()
	if (!address || typeof address !== "object") throw new Error("Worker internal API bridge did not bind a TCP port")
	const baseUrl = `http://127.0.0.1:${address.port}`
	return {
		baseUrl,
		token,
		env: {
			[INTERNAL_API_BASE_URL_ENV]: baseUrl,
			[INTERNAL_API_TOKEN_ENV]: token,
		},
		close: () => {
			try {
				server.close()
			} catch {}
		},
		inspect: () => ({ baseUrl }),
	}
}
