import { createInterface } from "node:readline"

/**
 * Tiny bidirectional JSON-RPC-ish transport over newline-delimited JSON.
 * Both peers may issue requests and notifications. stdout/stdin framing keeps
 * the local worker transport compatible with future docker/ssh runners.
 */
export class JsonLineRpc {
	/**
	 * @param {object} options
	 * @param {NodeJS.ReadableStream} options.input
	 * @param {NodeJS.WritableStream} options.output
	 * @param {(method: string, params: any) => any | Promise<any>} [options.onRequest]
	 * @param {(method: string, params: any) => void | Promise<void>} [options.onNotification]
	 * @param {(err: Error) => void} [options.onProtocolError]
	 * @param {boolean} [options.rejectPendingOnClose]
	 */
	constructor(options) {
		this.input = options.input
		this.output = options.output
		this.onRequest = options.onRequest
		this.onNotification = options.onNotification
		this.onProtocolError = options.onProtocolError ?? (() => {})
		this.rejectPendingOnClose = options.rejectPendingOnClose !== false
		this.nextId = 1
		/** @type {Map<number, { resolve: (value: any) => void, reject: (err: Error) => void }>} */
		this.pending = new Map()
		this.closed = false
		this.reader = createInterface({ input: this.input })
		this.reader.on("line", (line) => this.handleLine(line))
		this.reader.on("close", () => this.closePending(this.rejectPendingOnClose ? new Error("JSON line RPC closed") : undefined))
	}

	/** @param {string} method @param {any} [params] */
	request(method, params = {}) {
		if (this.closed) return Promise.reject(new Error("JSON line RPC is closed"))
		const id = this.nextId++
		const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
		// Some runtimes report a rejection as unhandled when a peer closes in
		// the same tick that the caller is attaching its own handler. Keep an
		// internal no-op handler while still returning the original rejecting
		// promise to callers that await/catch it.
		promise.catch(() => {})
		this.write({ id, method, params })
		return promise
	}

	/** @param {string} method @param {any} [params] */
	notify(method, params = {}) {
		if (this.closed) return
		this.write({ method, params })
	}

	/** @param {any} message */
	write(message) {
		try {
			this.output.write(`${JSON.stringify(message)}\n`)
		} catch (err) {
			this.closePending(err instanceof Error ? err : new Error(String(err)))
		}
	}

	/** @param {string} line */
	handleLine(line) {
		if (!line.trim()) return
		let message
		try {
			message = JSON.parse(line)
		} catch (err) {
			this.onProtocolError(err instanceof Error ? err : new Error(String(err)))
			return
		}
		if (Object.prototype.hasOwnProperty.call(message, "result") || Object.prototype.hasOwnProperty.call(message, "error")) {
			const pending = this.pending.get(message.id)
			if (!pending) return
			this.pending.delete(message.id)
			if (message.error) pending.reject(Object.assign(new Error(message.error.message || String(message.error)), message.error))
			else pending.resolve(message.result)
			return
		}
		if (Object.prototype.hasOwnProperty.call(message, "id")) {
			this.handleRequest(message).catch((err) => {
				this.write({ id: message.id, error: { message: err?.message ?? String(err), code: err?.code, stack: err?.stack } })
			})
			return
		}
		if (message.method) {
			Promise.resolve(this.onNotification?.(message.method, message.params)).catch((err) => this.onProtocolError(err instanceof Error ? err : new Error(String(err))))
		}
	}

	/** @param {any} message */
	async handleRequest(message) {
		if (!this.onRequest) throw new Error(`No request handler for ${message.method}`)
		const result = await this.onRequest(message.method, message.params)
		this.write({ id: message.id, result: result === undefined ? null : result })
	}

	/** @param {Error} [err] */
	closePending(err) {
		if (this.closed) return
		this.closed = true
		for (const pending of this.pending.values()) {
			if (this.rejectPendingOnClose) pending.reject(err ?? new Error("JSON line RPC closed"))
			else pending.resolve(undefined)
		}
		this.pending.clear()
	}

	close() {
		this.reader.close()
		this.closePending(new Error("JSON line RPC closed"))
	}
}
