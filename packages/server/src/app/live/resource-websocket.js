import { createLiveResourceSession } from "./resource-server.js"
import { acceptWebSocket, rejectWebSocketUpgrade } from "../websocket/server.js"

function heapUsedBytes(diagnostics) {
	if (diagnostics?.enabled !== true || typeof process.memoryUsage !== "function") return undefined
	return process.memoryUsage().heapUsed
}

export function serializeLiveMessage(message, diagnostics) {
	const heapUsedBeforeBytes = heapUsedBytes(diagnostics)
	const end = diagnostics?.span?.("service.live.serialize", {
		messageType: message?.type,
		resource: message?.resource,
		subscriptionId: message?.id,
		sessionId: message?.data?.sessionId,
	})
	try {
		const serialized = JSON.stringify(message)
		if (typeof serialized !== "string") throw new TypeError("Live protocol messages must be JSON-serializable values")
		const heapUsedAfterBytes = heapUsedBytes(diagnostics)
		end?.({
			serializedBytes: Buffer.byteLength(serialized),
			...(heapUsedBeforeBytes === undefined || heapUsedAfterBytes === undefined ? {} : {
				heapUsedBeforeBytes,
				heapUsedAfterBytes,
				heapDeltaBytes: heapUsedAfterBytes - heapUsedBeforeBytes,
			}),
		})
		return serialized
	} catch (err) {
		end?.({ error: true })
		throw err
	}
}

/**
 * Bind live resources to one authenticated WebSocket path. Authentication and resources stay transport-independent; this object owns connection and resource cleanup.
 */
export function createLiveResourceWebSocketServer(options) {
	const connections = new Set()
	const path = options.path
	return {
		async upgrade(incoming, socket, head) {
			const url = new URL(incoming.url || "/", `http://${incoming.headers.host || "localhost"}`)
			if (url.pathname !== path) return false
			socket.pause?.()
			const auth = await options.authenticate?.(incoming, url) ?? { ok: true }
			if (!auth.ok) {
				rejectWebSocketUpgrade(socket, auth.status ?? 401, auth.message ?? auth.error ?? "Unauthorized")
				return true
			}
			let connection
			let session
			acceptWebSocket(incoming, socket, head, {
				onOpen(opened) {
					connection = opened
					connections.add(opened)
					session = createLiveResourceSession({
						resources: options.resources,
						send: (message) => opened.sendText(serializeLiveMessage(message, options.diagnostics)),
					})
				},
				onMessage(message) {
					session?.receive(message)
				},
				onClose() {
					session?.close()
					if (connection) connections.delete(connection)
				},
				onError(err) {
					options.onError?.(err)
				},
			})
			return true
		},
		close() {
			for (const connection of [...connections]) connection.close(1001, "Server closing")
			connections.clear()
			for (const resource of Object.values(options.resources)) resource.close?.()
		},
		connectionCount() {
			return connections.size
		},
	}
}
