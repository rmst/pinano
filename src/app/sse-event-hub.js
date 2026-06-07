const encoder = new TextEncoder()
const DEFAULT_MAX_QUEUED_CHUNKS = 256

function sseData(event) {
	return encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
}

function sseHeartbeat() {
	return encoder.encode(": pinano heartbeat\n\n")
}

function enqueueClient(client, chunk) {
	try {
		if (client.queuedChunks >= client.maxQueuedChunks) {
			client.release()
			return false
		}
		client.controller.enqueue(chunk)
		client.queuedChunks += 1
		client.lastEnqueueAt = Date.now()
		return true
	} catch {
		client.release()
		return false
	}
}

export function createEventHub(onActivity = () => {}, options = {}) {
	/** @type {Map<string, { controller: ReadableStreamDefaultController<Uint8Array>, release: () => void, maxQueuedChunks: number, queuedChunks: number, createdAt: number, lastPullAt: number, lastEnqueueAt: number, initialEventType?: string, sessionId?: string }>} */
	const clients = new Map()
	let nextClientId = 1
	const heartbeatIntervalMs = Number.isFinite(options.heartbeatIntervalMs) ? Math.max(0, options.heartbeatIntervalMs) : 10000
	const maxQueuedChunks = Number.isFinite(options.maxQueuedChunks) ? Math.max(1, options.maxQueuedChunks) : DEFAULT_MAX_QUEUED_CHUNKS
	return {
		stream(initialEvent, signal) {
			/** @type {ReadableStreamDefaultController<Uint8Array> | undefined} */
			let streamController
			const clientId = String(nextClientId++)
			let released = false
			let heartbeatTimer = /** @type {NodeJS.Timeout | undefined} */ (undefined)
			const clearHeartbeat = () => {
				if (heartbeatTimer) clearInterval(heartbeatTimer)
				heartbeatTimer = undefined
			}
			const release = () => {
				if (released) return
				released = true
				clearHeartbeat()
				clients.delete(clientId)
				signal?.removeEventListener?.("abort", release)
				try { streamController?.close() } catch {}
				onActivity()
			}
			const startHeartbeat = () => {
				if (heartbeatIntervalMs <= 0) return
				heartbeatTimer = setInterval(() => {
					const client = clients.get(clientId)
					if (client) enqueueClient(client, sseHeartbeat())
				}, heartbeatIntervalMs)
				heartbeatTimer.unref?.()
			}
			return new Response(new ReadableStream({
				start(controller) {
					streamController = controller
					const now = Date.now()
					const client = {
						controller,
						release,
						maxQueuedChunks,
						queuedChunks: 0,
						createdAt: now,
						lastPullAt: now,
						lastEnqueueAt: now,
						initialEventType: typeof initialEvent?.type === "string" ? initialEvent.type : undefined,
						sessionId: typeof initialEvent?.sessionId === "string" ? initialEvent.sessionId : undefined,
					}
					clients.set(clientId, client)
					signal?.addEventListener?.("abort", release, { once: true })
					onActivity()
					if (signal?.aborted) release()
					else {
						enqueueClient(client, sseData({ ...initialEvent, eventClientId: clientId }))
						startHeartbeat()
					}
				},
				cancel() {
					release()
				},
				pull() {
					const client = clients.get(clientId)
					if (client) {
						client.queuedChunks = 0
						client.lastPullAt = Date.now()
					}
				},
			}), {
				headers: {
					"content-type": "text/event-stream; charset=utf-8",
					"cache-control": "no-cache",
					"connection": "keep-alive",
				},
			})
		},
		send(event) {
			const chunk = sseData(event)
			for (const [, client] of [...clients]) enqueueClient(client, chunk)
			onActivity()
		},
		closeClient(clientId) {
			const client = clients.get(clientId)
			if (client) client.release()
			else onActivity()
		},
		closeAll() {
			for (const client of [...clients.values()]) client.release()
			onActivity()
		},
		clientCount() {
			return clients.size
		},
		inspect(now = Date.now()) {
			return {
				clientCount: clients.size,
				maxQueuedChunks,
				heartbeatIntervalMs,
				clients: [...clients.entries()].map(([id, client]) => ({
					id,
					ageMs: now - client.createdAt,
					idleMs: now - client.lastPullAt,
					queuedChunks: client.queuedChunks,
					maxQueuedChunks: client.maxQueuedChunks,
					lastEnqueueAgeMs: now - client.lastEnqueueAt,
					initialEventType: client.initialEventType,
					sessionId: client.sessionId,
				})),
			}
		},
	}
}
