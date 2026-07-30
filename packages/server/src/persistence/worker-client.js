// Ordered request client shared by persistence workers. Database-specific modules own their commands and map these neutral lifecycle metrics into their public diagnostics.

function errorFromRecord(record, fallback) {
	const error = new Error(record?.message || fallback)
	if (record?.name) error.name = record.name
	if (record?.code !== undefined) error.code = record.code
	if (record?.status !== undefined) error.status = record.status
	return error
}

function errorRecord(error) {
	return {
		name: error instanceof Error ? error.name : "Error",
		message: error instanceof Error ? error.message : String(error),
		code: typeof error?.code === "string" || typeof error?.code === "number" ? error.code : undefined,
		status: Number.isInteger(error?.status) ? error.status : undefined,
	}
}

async function createRuntimeWorker(workerPath) {
	if (typeof globalThis.Worker === "function") {
		const native = new globalThis.Worker(workerPath)
		return {
			postMessage: (message) => native.postMessage(message),
			terminate: () => native.terminate(),
			ref: () => native.ref?.(),
			unref: () => native.unref?.(),
			onMessage: (handler) => { native.onmessage = (event) => handler(event.data) },
			onError: (handler) => { native.onerror = handler },
			onExit: () => {},
		}
	}

	const { Worker } = await import("node:worker_threads")
	// Node's test runner adds internal exec arguments which workers reject. Preserve only warning controls that are independently valid for a worker.
	const execArgv = process.execArgv.filter((arg) => arg === "--no-warnings" || arg.startsWith("--disable-warning="))
	const native = new Worker(workerPath, { execArgv })
	return {
		postMessage: (message) => native.postMessage(message),
		terminate: () => native.terminate(),
		ref: () => native.ref(),
		unref: () => native.unref(),
		onMessage: (handler) => native.on("message", handler),
		onError: (handler) => native.on("error", handler),
		onExit: (handler) => native.on("exit", handler),
	}
}

export class OrderedWorkerClient {
	#activeOperation
	#closing = false
	#closePromise
	#databasePath
	#diagnosticTid
	#diagnostics
	#expectedTermination = false
	#failedNotifications = 0
	#generation = 0
	#label
	#lastError
	#maxQueuedNotifications = 0
	#nextMessageId = 1
	#pending = new Map()
	#replayAfterFailure
	#restartDelayMs
	#restartTimer
	#startPromise
	#state = "idle"
	#warn
	#warned = false
	#worker
	#workerPath
	#workerRestarts = 0

	constructor(options) {
		this.#workerPath = options.workerPath
		this.#label = options.label
		this.#diagnosticTid = options.diagnosticTid
		this.#replayAfterFailure = options.replayAfterFailure === true
		this.#restartDelayMs = options.restartDelayMs ?? 1000
		this.#warn = options.warn
	}

	setDiagnostics(value) {
		this.#diagnostics = value?.enabled === false ? undefined : value
	}

	#recordSpans(spans = []) {
		for (const span of spans) {
			if (typeof this.#diagnostics?.completedSpan === "function") {
				this.#diagnostics.completedSpan(span.name, span.args, {
					startedAtEpochMs: span.startedAtEpochMs,
					durationMs: span.durationMs,
					tid: this.#diagnosticTid,
				})
				continue
			}
			if (typeof this.#diagnostics?.span === "function") {
				const end = this.#diagnostics.span(span.name, span.args)
				end({ durationMs: span.durationMs, worker: true })
			}
		}
	}

	#recordFailure(error, kind) {
		this.#lastError = { ...errorRecord(error), at: new Date().toISOString(), kind }
		this.#diagnostics?.instant?.(`${this.#label}.workerError`, {
			kind,
			errorName: this.#lastError.name,
			errorCode: this.#lastError.code,
		})
	}

	#warnOnce(error) {
		if (this.#warned || process.env.CEREX_TEST === "1") return
		this.#warned = true
		this.#warn?.(error)
	}

	#removePending(messageId) {
		const item = this.#pending.get(messageId)
		if (!item) return undefined
		this.#pending.delete(messageId)
		return item
	}

	#settlePending(error, { countNotifications = false } = {}) {
		for (const [messageId, item] of this.#pending) {
			this.#removePending(messageId)
			if (item.notification) {
				if (countNotifications) this.#failedNotifications++
				continue
			}
			item.reject(error)
		}
	}

	#scheduleRestart() {
		if (this.#pending.size === 0 || this.#restartTimer) return
		this.#restartTimer = setTimeout(() => {
			this.#restartTimer = undefined
			void this.#ensureWorker().catch(() => {})
		}, this.#restartDelayMs)
	}

	#handleWorkerFailure(error, failedGeneration, { fatal = false } = {}) {
		if (failedGeneration !== this.#generation || this.#expectedTermination || (this.#state === "failed" && !this.#worker)) return
		this.#recordFailure(error, fatal ? "initialization" : "runtime")
		this.#activeOperation = undefined
		this.#state = "failed"
		const failedWorker = this.#worker
		this.#worker = undefined
		this.#startPromise = undefined
		try { void failedWorker?.terminate() } catch {}

		if (fatal || !this.#replayAfterFailure) {
			this.#settlePending(error, { countNotifications: true })
			this.#warnOnce(error)
			return
		}

		for (const item of this.#pending.values()) item.sentGeneration = undefined
		this.#scheduleRestart()
	}

	#postItem(item) {
		try {
			this.#worker.postMessage(item.message)
			item.sentGeneration = this.#generation
		} catch (error) {
			this.#removePending(item.message.messageId)
			this.#recordFailure(error, "postMessage")
			if (item.notification) {
				this.#failedNotifications++
				this.#warnOnce(error)
			} else {
				item.reject(error)
			}
			if (this.#pending.size === 0) this.#worker?.unref()
		}
	}

	#sendPending() {
		if (!this.#worker || this.#state !== "running") return
		for (const item of this.#pending.values()) {
			if (item.sentGeneration === this.#generation) continue
			this.#postItem(item)
		}
	}

	#handleComplete(message) {
		this.#recordSpans(message.spans)
		if (this.#activeOperation?.messageId === message.messageId) this.#activeOperation = undefined
		const item = this.#removePending(message.messageId)
		if (!item) return
		if (message.error) {
			const error = errorFromRecord(message.error, `${this.#label} worker request failed`)
			this.#recordFailure(error, item.notification ? "notification" : "request")
			if (item.notification) {
				this.#failedNotifications++
				this.#warnOnce(error)
			} else {
				item.reject(error)
			}
		} else {
			item.resolve?.(message.result)
		}
		if (this.#pending.size === 0) this.#worker?.unref()
	}

	#handleMessage(message, messageGeneration) {
		if (messageGeneration !== this.#generation || !message || typeof message !== "object") return
		if (message.type === "ready") {
			this.#recordSpans(message.spans)
			this.#state = "running"
			this.#sendPending()
			if (this.#pending.size === 0) this.#worker?.unref()
			return
		}
		if (message.type === "active") {
			this.#activeOperation = {
				messageId: message.messageId,
				operation: message.operation,
				meta: message.meta,
				startedAtEpochMs: message.startedAtEpochMs,
			}
			return
		}
		if (message.type === "complete") {
			this.#handleComplete(message)
			return
		}
		if (message.type === "fatal") {
			this.#recordSpans(message.spans)
			this.#handleWorkerFailure(errorFromRecord(message.error, `${this.#label} worker failed to initialize`), messageGeneration, { fatal: true })
		}
	}

	async #startWorker() {
		const restarting = this.#state === "failed"
		this.#state = "starting"
		if (restarting) this.#workerRestarts++
		this.#expectedTermination = false
		const currentGeneration = ++this.#generation
		try {
			const created = await createRuntimeWorker(this.#workerPath)
			if (currentGeneration !== this.#generation) {
				try { void created.terminate() } catch {}
				return
			}
			this.#worker = created
			created.onMessage((message) => this.#handleMessage(message, currentGeneration))
			created.onError((error) => this.#handleWorkerFailure(error instanceof Error ? error : errorFromRecord(error, `${this.#label} worker failed`), currentGeneration))
			created.onExit((code) => {
				if (code !== 0 || !this.#expectedTermination) this.#handleWorkerFailure(new Error(`${this.#label} worker exited with code ${code}`), currentGeneration)
			})
			created.postMessage({ type: "init", path: this.#databasePath })
		} catch (error) {
			this.#handleWorkerFailure(error, currentGeneration, { fatal: true })
		}
	}

	#ensureWorker(path = this.#databasePath) {
		if (!path) return Promise.reject(new Error(`${this.#label} database path is required`))
		if (this.#databasePath && this.#databasePath !== path && (this.#worker || this.#pending.size > 0)) {
			return Promise.reject(new Error(`${this.#label} database path changed while its worker was active; close it before changing environments`))
		}
		this.#databasePath = path
		if (this.#worker && (this.#state === "starting" || this.#state === "running")) return this.#startPromise ?? Promise.resolve()
		if (!this.#startPromise) this.#startPromise = this.#startWorker().finally(() => {
			if (this.#state !== "starting") this.#startPromise = undefined
		})
		return this.#startPromise
	}

	#queue(path, operation, payload, meta, controls) {
		const messageId = this.#nextMessageId++
		const item = {
			message: { type: "operation", messageId, operation, payload, meta, path },
			...controls,
		}
		this.#pending.set(messageId, item)
		this.#maxQueuedNotifications = Math.max(this.#maxQueuedNotifications, this.#queuedNotifications())
		this.#worker?.ref()
		if (this.#state === "running" && this.#worker) this.#postItem(item)
		else void this.#ensureWorker(path).catch(() => {})
	}

	#assertPath(path) {
		if (typeof path !== "string" || !path) throw new Error(`${this.#label} database path is required`)
		if (this.#databasePath && this.#databasePath !== path && (this.#worker || this.#pending.size > 0)) {
			throw new Error(`${this.#label} database path changed while its worker was active`)
		}
		this.#databasePath = this.#databasePath ?? path
	}

	#queuedNotifications() {
		let count = 0
		for (const item of this.#pending.values()) {
			if (item.notification) count++
		}
		return count
	}

	enqueue(path, operation, payload, meta = {}) {
		if (this.#closing) {
			const error = new Error(`${this.#label} worker is closing`)
			this.#recordFailure(error, "enqueue")
			this.#failedNotifications++
			return false
		}
		try {
			this.#assertPath(path)
		} catch (error) {
			this.#recordFailure(error, "enqueue")
			this.#failedNotifications++
			return false
		}
		this.#queue(path, operation, payload, meta, { notification: true })
		return true
	}

	request(path, operation, payload = {}, meta = {}) {
		if (this.#closing && operation !== "close") return Promise.reject(new Error(`${this.#label} worker is closing`))
		try {
			this.#assertPath(path)
		} catch (error) {
			return Promise.reject(error)
		}
		return new Promise((resolve, reject) => {
			this.#queue(path, operation, payload, meta, { notification: false, resolve, reject })
		})
	}

	async #performClose() {
		if (!this.#worker && this.#pending.size === 0 && !this.#startPromise) {
			this.#databasePath = undefined
			this.#state = "idle"
			return
		}
		this.#closing = true
		if (this.#restartTimer) {
			clearTimeout(this.#restartTimer)
			this.#restartTimer = undefined
		}
		try {
			await this.request(this.#databasePath, "close")
		} finally {
			this.#expectedTermination = true
			const closingWorker = this.#worker
			this.#worker = undefined
			try { await closingWorker?.terminate() } catch {}
			this.#settlePending(new Error(`${this.#label} worker closed before completing the request`))
			this.#activeOperation = undefined
			this.#databasePath = undefined
			this.#startPromise = undefined
			this.#state = "idle"
			this.#closing = false
		}
	}

	close() {
		if (!this.#closePromise) this.#closePromise = this.#performClose().finally(() => { this.#closePromise = undefined })
		return this.#closePromise
	}

	status() {
		const queuedNotifications = this.#queuedNotifications()
		return {
			state: this.#state,
			queuedNotifications,
			pendingRequests: this.#pending.size - queuedNotifications,
			maxQueuedNotifications: this.#maxQueuedNotifications,
			failedNotifications: this.#failedNotifications,
			workerRestarts: this.#workerRestarts,
			...(this.#activeOperation ? {
				activeOperation: {
					...this.#activeOperation.meta,
					operation: this.#activeOperation.operation,
					elapsedMs: Math.max(0, Date.now() - this.#activeOperation.startedAtEpochMs),
				},
			} : {}),
			...(this.#lastError ? { lastError: this.#lastError } : {}),
		}
	}

	resetStatus() {
		this.#failedNotifications = 0
		this.#workerRestarts = 0
		this.#maxQueuedNotifications = 0
		this.#lastError = undefined
	}
}
