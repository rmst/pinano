import * as http from "node:http"
import * as net from "node:net"

import { HOP_BY_HOP_HEADERS, proxyHttpRequest, requestPath } from "../http/proxy.js"
import { serveStaticPreviewDocumentLink, serveStaticPreviewRequest } from "../preview/static-server.js"

function socketError(socket, status, message) {
	if (socket.destroyed) return
	socket.write([
		`HTTP/1.1 ${status} ${message}`,
		"content-type: text/plain; charset=utf-8",
		"cache-control: no-store",
		"connection: close",
		"",
		message,
	].join("\r\n"))
	socket.destroy()
}

function healthRequest(host, port, path, timeoutMs) {
	return new Promise((resolve, reject) => {
		let settled = false
		let timer
		const finish = (fn, value) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			req.destroy()
			fn(value)
		}
		timer = setTimeout(() => finish(reject, new Error(`Preview health check timed out after ${timeoutMs}ms`)), timeoutMs)
		timer.unref?.()
		const req = http.request({ host, port, path, method: "GET", headers: { connection: "close" } }, (res) => {
			res.on("data", () => {})
			finish(resolve, res.statusCode ?? 0)
		})
		req.on("error", (err) => finish(reject, err))
		req.end()
	})
}

function allocatePort(host) {
	return new Promise((resolve, reject) => {
		const server = net.createServer()
		server.unref?.()
		server.once("error", reject)
		server.listen(0, host, () => {
			const address = server.address()
			const port = typeof address === "object" && address ? address.port : undefined
			server.close((err) => {
				if (err) reject(err)
				else if (!port) reject(new Error("Could not allocate preview port"))
				else resolve(port)
			})
		})
	})
}

function upgradeProcess(incoming, socket, head, target, headers) {
	const upstream = http.request({
		host: target.host,
		port: target.port,
		method: incoming.method,
		path: incoming.url || "/",
		headers,
	})
	upstream.on("upgrade", (response, upstreamSocket, upstreamHead) => {
		if (socket.destroyed) {
			upstreamSocket.destroy()
			return
		}
		const lines = [`HTTP/${response.httpVersion} ${response.statusCode} ${response.statusMessage}`]
		for (const [name, value] of Object.entries(response.headers)) {
			const lower = name.toLowerCase()
			if (HOP_BY_HOP_HEADERS.has(lower) || lower === "set-cookie") continue
			if (Array.isArray(value)) for (const item of value) lines.push(`${name}: ${item}`)
			else if (value !== undefined) lines.push(`${name}: ${value}`)
		}
		lines.push("connection: Upgrade")
		if (response.headers.upgrade) lines.push(`upgrade: ${response.headers.upgrade}`)
		socket.write(`${lines.join("\r\n")}\r\n\r\n`)
		if (upstreamHead?.length) socket.write(upstreamHead)
		if (head?.length) upstreamSocket.write(head)
		upstreamSocket.pipe(socket)
		socket.pipe(upstreamSocket)
		upstreamSocket.on("error", () => socket.destroy())
		socket.on("error", () => upstreamSocket.destroy())
	})
	upstream.on("response", (response) => {
		if (socket.destroyed) {
			response.on("data", () => {})
			return
		}
		socket.write(`HTTP/${response.httpVersion} ${response.statusCode} ${response.statusMessage}\r\nconnection: close\r\n\r\n`)
		response.pipe(socket)
		response.on("end", () => socket.destroy())
	})
	upstream.on("error", (err) => socketError(socket, 502, err?.message ?? "Preview proxy error"))
	upstream.end()
}

export function createLocalPreviewTransport() {
	return Object.freeze({
		allocatePort,
		health: (target, path, timeoutMs) => healthRequest(target.host, target.port, path, timeoutMs),
		fetchProcess: (request, target, options = {}) => proxyHttpRequest(request, {
			host: target.host,
			port: target.port,
			path: requestPath(request.url),
			headers: options.headers ?? Object.fromEntries(request.headers),
		}),
		upgradeProcess,
		serveStatic: serveStaticPreviewRequest,
		openStaticDocument: serveStaticPreviewDocumentLink,
	})
}
