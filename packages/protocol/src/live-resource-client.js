import { LIVE_RESOURCE_PROTOCOL_VERSION } from "./live-resource-protocol.js"

import { canonicalProductErrorCode } from "./product.js"

const DEFAULT_RECONNECT_DELAY_MS = 250
const DEFAULT_MAX_RECONNECT_DELAY_MS = 10_000
const DEFAULT_SUBSCRIPTION_RETRY_DELAY_MS = 500
const DEFAULT_MAX_SUBSCRIPTION_RETRY_DELAY_MS = 30_000

function socketIsOpen(socket) {
	return socket?.readyState === 1
}

function connectionClosedError(event) {
	const detail = typeof event?.reason === "string" && event.reason ? `: ${event.reason}` : ""
	return Object.assign(new Error(`Live connection closed${detail}`), {
		code: "CEREX_LIVE_CONNECTION_CLOSED",
		closeCode: event?.code,
	})
}

function retryableSubscriptionError(message) {
	const status = message?.status
	return !Number.isSafeInteger(status)
		|| status >= 500
		|| status === 408
		|| status === 409
		|| status === 425
		|| status === 429
}

/** Runtime-independent multiplexed client for the Cerex live-resource protocol. onOpen reports a transport handshake; onReady reports that an individual subscription is established. Environment wrappers own URL construction and visibility/runtime lifecycle. */
export class LiveResourceClient {
	constructor(options = {}) {
		this.options = options
		this.socket = null
		this.ready = false
		this.subscriptions = new Map()
		this.reconnectTimer = undefined
		this.reconnectAttempt = 0
		this.nextId = 1
		this.disposed = false
		this.protocolRejected = false
		this.suspended = false
	}

	subscribe(resource, params, handlers) {
		const id = `live:${this.nextId++}`
		const subscription = {
			id,
			resource,
			params,
			handlers,
			cursor: undefined,
			failed: false,
			retryAttempt: 0,
			retryTimer: undefined,
		}
		this.subscriptions.set(id, subscription)
		this.ensureConnected()
		if (this.ready) {
			this.callHandler(subscription.handlers.onOpen)
			this.sendSubscription(subscription)
		}
		return {
			refresh: () => {
				if (!subscription.failed) return this.send({ type: "refresh", id })
				this.clearSubscriptionRetry(subscription)
				return this.sendSubscription(subscription)
			},
			unsubscribe: () => {
				if (!this.subscriptions.delete(id)) return
				this.clearSubscriptionRetry(subscription)
				this.send({ type: "unsubscribe", id })
				if (this.subscriptions.size === 0) this.disconnect()
			},
		}
	}

	setSuspended(suspended) {
		this.suspended = suspended === true
		if (this.suspended) this.disconnect()
		else this.ensureConnected()
	}

	restart() {
		if (this.disposed || this.protocolRejected || this.subscriptions.size === 0) return
		this.disconnect({ notify: true })
		this.reconnectAttempt = 0
		this.scheduleReconnect(0)
	}

	send(message) {
		if (!socketIsOpen(this.socket)) return false
		try {
			this.socket.send(JSON.stringify(message))
			return true
		} catch {
			return false
		}
	}

	sendSubscription(subscription) {
		const sent = this.send({
			type: "subscribe",
			id: subscription.id,
			resource: subscription.resource,
			params: subscription.params,
			...(subscription.cursor ? { cursor: subscription.cursor } : {}),
		})
		if (sent) subscription.failed = false
		return sent
	}

	clearSubscriptionRetry(subscription) {
		if (subscription.retryTimer !== undefined) clearTimeout(subscription.retryTimer)
		subscription.retryTimer = undefined
	}

	markSubscriptionReady(subscription) {
		this.clearSubscriptionRetry(subscription)
		subscription.failed = false
		subscription.retryAttempt = 0
	}

	scheduleSubscriptionRetry(subscription) {
		if (this.disposed || this.suspended || !this.ready || subscription.retryTimer !== undefined || !this.subscriptions.has(subscription.id)) return
		const baseDelay = Math.min(
			this.options.maxSubscriptionRetryDelayMs ?? DEFAULT_MAX_SUBSCRIPTION_RETRY_DELAY_MS,
			(this.options.subscriptionRetryDelayMs ?? DEFAULT_SUBSCRIPTION_RETRY_DELAY_MS) * (2 ** subscription.retryAttempt++),
		)
		const jitter = Math.floor(Math.random() * Math.min(500, baseDelay))
		subscription.retryTimer = setTimeout(() => {
			subscription.retryTimer = undefined
			if (!this.ready || !this.subscriptions.has(subscription.id)) return
			this.sendSubscription(subscription)
		}, baseDelay + jitter)
		subscription.retryTimer.unref?.()
	}

	notifyError(error, message = undefined) {
		for (const subscription of this.subscriptions.values()) this.callHandler(subscription.handlers.onError, error, message)
	}

	callHandler(handler, ...args) {
		if (typeof handler !== "function") return
		try {
			Promise.resolve(handler(...args)).catch((err) => this.options.onHandlerError?.(err))
		} catch (err) {
			this.options.onHandlerError?.(err)
		}
	}

	ensureConnected() {
		if (this.disposed || this.protocolRejected || this.suspended || this.subscriptions.size === 0 || this.socket || this.reconnectTimer) return
		let socket
		try {
			const url = typeof this.options.url === "function" ? this.options.url() : this.options.url
			const createSocket = this.options.createSocket ?? ((value) => new WebSocket(value))
			socket = createSocket(url)
		} catch (err) {
			this.connectionFailed(err)
			return
		}
		this.socket = socket
		this.ready = false
		socket.onmessage = (event) => this.receive(socket, event)
		socket.onclose = (event) => this.closed(socket, event)
		socket.onerror = () => {}
	}

	receive(socket, event) {
		if (this.socket !== socket) return
		let message
		try {
			message = JSON.parse(String(event.data))
		} catch {
			return
		}
		if (!message || typeof message !== "object" || Array.isArray(message)) return
		if (message.type === "heartbeat") return
		if (message.type === "hello") {
			if (message.protocol !== LIVE_RESOURCE_PROTOCOL_VERSION) {
				this.protocolRejected = true
				const error = new Error(`Unsupported live resource protocol: ${String(message.protocol)}`)
				this.notifyError(error, message)
				socket.close(1002, "Unsupported live resource protocol")
				return
			}
			this.ready = true
			this.reconnectAttempt = 0
			for (const subscription of this.subscriptions.values()) {
				this.clearSubscriptionRetry(subscription)
				this.callHandler(subscription.handlers.onOpen)
				this.sendSubscription(subscription)
			}
			return
		}
		const subscription = this.subscriptions.get(message.id)
		if (!subscription) return
		if (message.cursor) subscription.cursor = message.cursor
		if (message.type === "snapshot" || message.type === "update") {
			this.markSubscriptionReady(subscription)
			this.callHandler(subscription.handlers.onData, message.data, message)
			if (message.type === "snapshot") this.callHandler(subscription.handlers.onReady, message)
		} else if (message.type === "ready") {
			this.markSubscriptionReady(subscription)
			this.callHandler(subscription.handlers.onReady, message)
		} else if (message.type === "error") {
			subscription.failed = true
			const error = Object.assign(new Error(message.error || "Live resource error"), {
				...(Number.isSafeInteger(message.status) ? { status: message.status } : {}),
				...(typeof message.code === "string" ? { code: canonicalProductErrorCode(message.code) } : {}),
			})
			this.callHandler(subscription.handlers.onError, error, message)
			if (retryableSubscriptionError(message)) this.scheduleSubscriptionRetry(subscription)
		}
	}

	closed(socket, event) {
		if (this.socket !== socket) return
		this.socket = null
		this.ready = false
		for (const subscription of this.subscriptions.values()) {
			this.clearSubscriptionRetry(subscription)
			this.callHandler(subscription.handlers.onDisconnect, event)
		}
		if (this.protocolRejected) return
		if (this.options.reconnect === false) this.notifyError(connectionClosedError(event))
		else this.scheduleReconnect()
	}

	connectionFailed(err) {
		const error = err instanceof Error ? err : new Error(String(err))
		if (this.options.reconnect === false) this.notifyError(error)
		else this.scheduleReconnect()
	}

	scheduleReconnect(delayOverride = undefined) {
		if (this.disposed || this.protocolRejected || this.suspended || this.options.reconnect === false || this.subscriptions.size === 0 || this.reconnectTimer) return
		const baseDelay = delayOverride ?? Math.min(
			this.options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS,
			(this.options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS) * (2 ** this.reconnectAttempt++),
		)
		const jitter = delayOverride === undefined ? Math.floor(Math.random() * Math.min(500, baseDelay)) : 0
		this.reconnectTimer = setTimeout(async () => {
			this.reconnectTimer = undefined
			try {
				await this.options.beforeReconnect?.()
			} catch (err) {
				this.notifyError(err instanceof Error ? err : new Error(String(err)))
				this.scheduleReconnect()
				return
			}
			this.ensureConnected()
		}, baseDelay + jitter)
		this.reconnectTimer.unref?.()
	}

	disconnect(options = {}) {
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
		this.reconnectTimer = undefined
		const socket = this.socket
		this.socket = null
		this.ready = false
		for (const subscription of this.subscriptions.values()) this.clearSubscriptionRetry(subscription)
		if (options.notify) {
			for (const subscription of this.subscriptions.values()) this.callHandler(subscription.handlers.onDisconnect)
		}
		if (socket && socket.readyState < 2) socket.close(1000, "Live connection suspended")
	}

	dispose() {
		this.disposed = true
		for (const subscription of this.subscriptions.values()) this.clearSubscriptionRetry(subscription)
		this.subscriptions.clear()
		this.disconnect()
	}
}
