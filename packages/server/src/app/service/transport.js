import * as http from "node:http"

import { canonicalProductErrorCode, productErrorCodeMatches } from "../../../../protocol/src/product.js"
import { serviceHostForConnect } from "./network.js"

export function serviceHttpOptions(info, path) {
	if (info.transport === "tcp") return { host: serviceHostForConnect(info.host), port: info.port, path }
	throw Object.assign(new Error(`Unsupported Cerex service transport: ${info.transport || "unknown"}`), { code: "CEREX_UNSUPPORTED_SERVICE_TRANSPORT" })
}

export function serviceWebSocketUrl(info, path) {
	if (info.transport !== "tcp") throw Object.assign(new Error(`Unsupported Cerex service transport: ${info.transport || "unknown"}`), { code: "CEREX_UNSUPPORTED_SERVICE_TRANSPORT" })
	const host = serviceHostForConnect(info.host)
	const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host
	const url = new URL(`ws://${authority}:${info.port}${path}`)
	if (info.token) url.searchParams.set("token", info.token)
	return url.href
}

export function serviceTimeoutError(kind, path, timeoutMs) {
	const suffix = path ? ` (${path})` : ""
	return Object.assign(new Error(`Cerex service ${kind} timed out after ${timeoutMs}ms${suffix}`), { code: "CEREX_SERVICE_TIMEOUT" })
}

export function isServiceTimeoutError(err) {
	if (productErrorCodeMatches(err, "CEREX_SERVICE_TIMEOUT")) return true
	return /timed out/i.test(String(/** @type {any} */ (err)?.message ?? err))
}

/**
 * @param {any} info
 * @param {string} path
 * @param {{ method?: string, body?: string, headers?: Record<string, string>, signal?: AbortSignal, timeoutMs?: number }} [options]
 * @returns {Promise<{ status: number, headers: import("node:http").IncomingHttpHeaders, body: string }>}
 */
export async function requestText(info, path, options = {}) {
	const res = await requestBytes(info, path, options)
	return {
		...res,
		body: new TextDecoder().decode(res.body),
	}
}

/**
 * @param {any} info
 * @param {string} path
 * @param {{ method?: string, body?: string, headers?: Record<string, string>, signal?: AbortSignal, timeoutMs?: number }} [options]
 * @returns {Promise<{ status: number, headers: import("node:http").IncomingHttpHeaders, body: Buffer }>}
 */
export function requestBytes(info, path, options = {}) {
	return new Promise((resolve, reject) => {
		const body = options.body ?? ""
		const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, options.timeoutMs) : 0
		let settled = false
		let timeoutTimer = /** @type {NodeJS.Timeout | undefined} */ (undefined)
		let req = /** @type {import("node:http").ClientRequest | undefined} */ (undefined)
		const cleanup = () => {
			if (timeoutTimer) clearTimeout(timeoutTimer)
			options.signal?.removeEventListener?.("abort", abortRequest)
		}
		const settle = (fn, value) => {
			if (settled) return
			settled = true
			cleanup()
			fn(value)
		}
		const fail = (err) => settle(reject, err)
		const abortRequest = () => {
			const err = Object.assign(new Error(`Cerex service request aborted (${path})`), { code: "ABORT_ERR" })
			fail(err)
			req?.destroy?.(err)
		}
		req = http.request({
			...serviceHttpOptions(info, path),
			method: options.method ?? "GET",
			headers: {
				"host": "cerex.local",
				"connection": "close",
				...(info.token ? { "authorization": `Bearer ${info.token}` } : {}),
				...(body ? { "content-length": String(Buffer.byteLength(body)) } : {}),
				...(options.headers || {}),
			},
		}, (res) => {
			const chunks = []
			res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
			res.on("end", () => {
				settle(resolve, {
					status: res.statusCode ?? 0,
					headers: res.headers ?? {},
					body: Buffer.concat(chunks),
				})
				req.destroy?.()
			})
			res.on("aborted", () => fail(Object.assign(new Error(`Cerex service response aborted (${path})`), { code: "ECONNRESET" })))
			res.on("error", fail)
		})
		req.on("error", fail)
		if (timeoutMs > 0) {
			timeoutTimer = setTimeout(() => {
				const err = serviceTimeoutError("request", path, timeoutMs)
				fail(err)
				req?.destroy?.(err)
			}, timeoutMs)
			timeoutTimer.unref?.()
		}
		if (options.signal?.aborted) {
			abortRequest()
			return
		}
		options.signal?.addEventListener("abort", abortRequest, { once: true })
		if (body) req.write(body)
		req.end()
	})
}

export async function requestJson(info, path, options = {}) {
	const res = await requestText(info, path, {
		...options,
		headers: {
			"content-type": "application/json",
			...(options.headers || {}),
		},
	})
	const data = res.body ? JSON.parse(res.body) : {}
	if (res.status < 200 || res.status >= 300) {
		throw Object.assign(new Error(data.error || `HTTP ${res.status}`), {
			status: res.status,
			...(typeof data.code === "string" ? { code: canonicalProductErrorCode(data.code) } : {}),
		})
	}
	return data
}
