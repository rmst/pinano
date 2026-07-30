// Worker-side lifecycle, ordering, tracing, and error transport shared by persistence workers.

async function workerTransport() {
	if (typeof globalThis.self?.postMessage === "function") {
		return {
			send: (message) => globalThis.self.postMessage(message),
			subscribe: (handler) => { globalThis.self.onmessage = (event) => handler(event.data) },
		}
	}

	const { parentPort } = await import("node:worker_threads")
	if (!parentPort) throw new Error("Persistence worker started without a parent port")
	return {
		send: (message) => parentPort.postMessage(message),
		subscribe: (handler) => parentPort.on("message", handler),
	}
}

export function errorRecord(error) {
	return {
		name: error instanceof Error ? error.name : "Error",
		message: error instanceof Error ? error.message : String(error),
		code: typeof error?.code === "string" || typeof error?.code === "number" ? error.code : undefined,
		status: Number.isInteger(error?.status) ? error.status : undefined,
	}
}

class WorkerTraceScope {
	#defaultArgs
	#spans = []

	constructor(defaultArgs = {}) {
		this.#defaultArgs = defaultArgs
	}

	span(name, args = {}) {
		const startedAtEpochMs = Date.now()
		const startedAt = performance.now()
		return (extraArgs = {}) => {
			this.#spans.push({
				name,
				args: { ...this.#defaultArgs, ...args, ...extraArgs },
				startedAtEpochMs,
				durationMs: performance.now() - startedAt,
			})
		}
	}

	run(name, args, task) {
		const end = this.span(name, args)
		try {
			const result = task()
			end()
			return result
		} catch (error) {
			end({ failed: true, errorName: error instanceof Error ? error.name : typeof error })
			throw error
		}
	}

	diagnostics() {
		return {
			enabled: true,
			span: (name, args) => this.span(name, args),
		}
	}

	annotate(args) {
		this.#spans = this.#spans.map((span) => ({ ...span, args: { ...span.args, ...args } }))
	}

	spans() {
		return this.#spans
	}
}

export async function runPersistenceWorker(options) {
	const { send, subscribe } = await workerTransport()
	let resource
	let chain = Promise.resolve()

	const initialize = async (message) => {
		const trace = new WorkerTraceScope({ database: options.database })
		try {
			resource = await options.open(message.path, trace)
			send({ type: "ready", spans: trace.spans() })
		} catch (error) {
			send({ type: "fatal", error: errorRecord(error), spans: trace.spans() })
		}
	}

	const operate = async (message) => {
		if (!resource) {
			send({ type: "fatal", error: errorRecord(new Error(`${options.label} store is not initialized`)), spans: [] })
			return
		}
		const trace = new WorkerTraceScope(message.meta ?? {})
		send({
			type: "active",
			messageId: message.messageId,
			operation: message.operation,
			meta: message.meta ?? {},
			startedAtEpochMs: Date.now(),
		})
		try {
			let result
			if (message.operation === "close") {
				const closingResource = resource
				try {
					result = await options.close(closingResource, trace)
				} finally {
					resource = undefined
				}
			} else {
				result = await options.execute(resource, message.operation, message.payload ?? {}, trace)
			}
			send({ type: "complete", messageId: message.messageId, result, spans: trace.spans() })
		} catch (error) {
			send({ type: "complete", messageId: message.messageId, error: errorRecord(error), spans: trace.spans() })
		}
	}

	subscribe((message) => {
		if (!message || typeof message !== "object") return
		chain = chain.then(() => message.type === "init" ? initialize(message) : message.type === "operation" ? operate(message) : undefined)
		chain.catch((error) => {
			send({ type: "fatal", error: errorRecord(error), spans: [] })
		})
	})
}
