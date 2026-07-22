import { createInterface } from "node:readline"

export function bootstrapSource(tools, storedValues, maxOutputChars) {
	return `(() => {
		const definitions = ${JSON.stringify(tools)}
		const stored = new Map(${JSON.stringify(storedValues)})
		const pendingTools = new Map()
		class NestedToolError {
			constructor(message) { this.message = message }
			toString() { return this.message }
		}
		const timerCallbacks = new Map()
		const outbox = []
		const wakeHost = typeof globalThis.__pinanoCodeModeWake === "function" ? globalThis.__pinanoCodeModeWake : undefined
		const enqueue = (entry) => {
			outbox.push(entry)
			wakeHost?.()
		}
		let nextToolId = 1
		let nextTimerId = 1
		let outputChars = 0
		let outputTruncated = false
		// Stream a bounded prefix immediately and retain only the suffix that the outer head-tail truncator can use.
		let outputTail = []
		let outputTailStart = 0
		let outputTailChars = 0
		const maxOutputChars = ${JSON.stringify(maxOutputChars)}
		const maxOutputTailChars = Math.floor(maxOutputChars / 2)
		const clone = (value) => {
			const json = JSON.stringify(value)
			if (json === undefined) throw new TypeError("value is not JSON-serializable")
			return JSON.parse(json)
		}
		const appendOutputTail = (item) => {
			if (maxOutputTailChars === 0) return
			if (item.text.length >= maxOutputTailChars) {
				outputTail = [{ ...item, text: item.text.slice(-maxOutputTailChars) }]
				outputTailStart = 0
				outputTailChars = maxOutputTailChars
				return
			}
			outputTail.push(item)
			outputTailChars += item.text.length
			while (outputTailChars > maxOutputTailChars) {
				const excess = outputTailChars - maxOutputTailChars
				const first = outputTail[outputTailStart]
				if (first.text.length <= excess) {
					outputTailStart++
					outputTailChars -= first.text.length
				} else {
					outputTail[outputTailStart] = { ...first, text: first.text.slice(excess) }
					outputTailChars -= excess
				}
			}
			if (outputTailStart > 0 && outputTailStart * 2 >= outputTail.length) {
				outputTail = outputTail.slice(outputTailStart)
				outputTailStart = 0
			}
		}
		const flushOutputTail = () => {
			for (let index = outputTailStart; index < outputTail.length; index++) {
				enqueue({ type: "output", item: outputTail[index] })
			}
			outputTail = []
			outputTailStart = 0
			outputTailChars = 0
		}
		const appendOutput = (item) => {
			if (item?.type === "image") {
				enqueue({ type: "output", item })
				return
			}
			if (!item.text) return
			const remaining = Math.max(0, maxOutputChars - outputChars)
			if (!outputTruncated && item.text.length <= remaining) {
				outputChars += item.text.length
				enqueue({ type: "output", item })
				return
			}
			if (remaining > 0) {
				enqueue({ type: "output", item: { ...item, text: item.text.slice(0, remaining) } })
				outputChars += remaining
			}
			if (!outputTruncated) {
				outputTruncated = true
				enqueue({ type: "output", item: { type: "text", text: "[Cell output truncated]" } })
			}
			appendOutputTail({ ...item, text: item.text.slice(remaining) })
		}
		const textValue = (value) => {
			if (typeof value === "string") return value
			try {
				const json = JSON.stringify(value)
				return json === undefined ? String(value) : json
			} catch {
				return String(value)
			}
		}
		const normalizeImage = (value, detail) => {
			if (typeof value === "string") {
				const match = /^data:(image\\/[^;,]+);base64,(.+)$/s.exec(value)
				if (!match) throw new TypeError("image string must be a base64 data: URL")
				return { type: "image", mimeType: match[1], data: match[2], ...(detail ? { detail } : {}) }
			}
			if (!value || typeof value !== "object") throw new TypeError("image expects an image object or data: URL")
			if (value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string") {
				return { ...clone(value), ...(detail ? { detail } : {}) }
			}
			if (typeof value.image_url === "string") return normalizeImage(value.image_url, detail ?? value.detail)
			throw new TypeError("image object is missing image data")
		}
		const callTool = (definition, input) => {
			const id = String(nextToolId++)
			enqueue({ type: "tool_call", id, name: definition.name, kind: definition.kind, input: clone(input === undefined && definition.kind === "function" ? {} : input) })
			return new Promise((resolve, reject) => pendingTools.set(id, { resolve, reject }))
		}
		const toolsObject = Object.create(null)
		for (const definition of definitions) {
			Object.defineProperty(toolsObject, definition.globalName, {
				value: (input) => callTool(definition, input),
				enumerable: true,
			})
		}
		Object.freeze(toolsObject)
		Object.assign(globalThis, {
			console: undefined,
			tools: toolsObject,
			ALL_TOOLS: Object.freeze(definitions.map(({ name, description }) => Object.freeze({ name, description }))),
			text: (value) => appendOutput({ type: "text", text: textValue(value) }),
			image: (value, detail) => appendOutput(normalizeImage(value, detail)),
			store: (key, value) => {
				if (typeof key !== "string") throw new TypeError("store key must be a string")
				const cloned = clone(value)
				stored.set(key, cloned)
				enqueue({ type: "store", key, value: cloned })
			},
			load: (key) => {
				if (typeof key !== "string") throw new TypeError("load key must be a string")
				return stored.has(key) ? clone(stored.get(key)) : undefined
			},
			yield_control: () => {
				flushOutputTail()
				enqueue({ type: "yield" })
			},
			exit: () => { throw { __pinanoCodeModeExit: true } },
			setTimeout: (callback, delay = 0) => {
				if (typeof callback !== "function") throw new TypeError("setTimeout callback must be a function")
				const id = nextTimerId++
				timerCallbacks.set(id, callback)
				const numericDelay = Number(delay)
				enqueue({ type: "timer_start", id, delay: Number.isFinite(numericDelay) ? Math.max(0, numericDelay) : 0 })
				return id
			},
			clearTimeout: (id) => {
				timerCallbacks.delete(id)
				enqueue({ type: "timer_clear", id })
			},
		})
		return {
			drain: () => outbox.splice(0),
			deliver: (json) => {
				const message = JSON.parse(json)
				const target = pendingTools.get(message.id)
				if (!target) return
				pendingTools.delete(message.id)
				if (message.type === "tool_error") target.reject(new NestedToolError(message.error))
				else target.resolve(message.result)
			},
			fireTimer: (id) => {
				const callback = timerCallbacks.get(id)
				if (!callback) return
				timerCallbacks.delete(id)
				callback()
			},
			resetOutputBudget: () => {
				outputChars = 0
				outputTruncated = false
				outputTail = []
				outputTailStart = 0
				outputTailChars = 0
			},
			flushOutputTail,
		}
	})()`
}

/** @param {(params: any, host: { wake: () => void }) => { bridge: any, execution: Promise<unknown> | unknown }} createCell */
export function runCodeModeRunner(createCell) {
	const hostInput = process.stdin
	const hostOutput = process.stdout
	const exitProcess = process.exit.bind(process)
	const hostSetTimeout = globalThis.setTimeout
	const hostClearTimeout = globalThis.clearTimeout
	const hostSetImmediate = globalThis.setImmediate
	const HostError = globalThis.Error
	const HostPromise = globalThis.Promise
	const hostJsonParse = JSON.parse
	const hostJsonStringify = JSON.stringify
	const hostHasOwn = Function.call.bind(Object.prototype.hasOwnProperty)
	const hostAssign = Object.assign
	const HostString = globalThis.String
	const pending = new Map()
	const timers = new Map()
	let nextRequestId = 1
	let started = false
	let active = true
	let bridge
	let pumpScheduled = false
	let maxErrorChars = 40_000

	const write = (message) => {
		if (!hostOutput.destroyed) hostOutput.write(`${hostJsonStringify(message)}\n`)
	}
	const notify = (method, params = {}) => write({ method, params })
	const request = (method, params = {}) => {
		const id = nextRequestId++
		const promise = new HostPromise((resolve, reject) => pending.set(id, { resolve, reject }))
		promise.catch(() => {})
		write({ id, method, params })
		return promise
	}
	const drainOutbox = () => {
		if (!bridge || !active) return
		for (const entry of bridge.drain()) handleOutboxEntry(entry)
	}
	const schedulePump = () => {
		if (pumpScheduled || !active) return
		pumpScheduled = true
		hostSetImmediate(() => {
			pumpScheduled = false
			drainOutbox()
		})
	}
	const deliver = (message) => {
		if (!bridge || !active) return
		bridge.deliver(hostJsonStringify(message))
		schedulePump()
	}
	const handleOutboxEntry = (entry) => {
		switch (entry.type) {
			case "tool_call":
				void request("tool_call", entry).then(
					(result) => deliver({ type: "tool_result", id: entry.id, result }),
					(error) => deliver({ type: "tool_error", id: entry.id, error: error instanceof HostError ? error.message : HostString(error) }),
				)
				break
			case "output":
				notify("output", { item: entry.item })
				break
			case "yield":
				notify("yield")
				break
			case "store":
				notify("store", { key: entry.key, value: entry.value })
				break
			case "timer_start": {
				const timer = hostSetTimeout(() => {
					timers.delete(entry.id)
					if (active) {
						bridge.fireTimer(entry.id)
						schedulePump()
					}
				}, entry.delay)
				timers.set(entry.id, timer)
				break
			}
			case "timer_clear": {
				const timer = timers.get(entry.id)
				if (timer !== undefined) hostClearTimeout(timer)
				timers.delete(entry.id)
				break
			}
		}
	}
	const finish = (error) => {
		if (!active) return
		bridge?.flushOutputTail()
		drainOutbox()
		active = false
		for (const timer of timers.values()) hostClearTimeout(timer)
		timers.clear()
		const exited = Boolean(error && typeof error === "object" && error.__pinanoCodeModeExit === true)
		const rawError = error instanceof HostError
			? error.stack && error.message && !error.stack.includes(error.message)
				? `${error.message}\n${error.stack}`
				: error.stack || error.message
			: HostString(error)
		const errorHeadChars = Math.ceil(maxErrorChars / 2)
		const errorTailChars = Math.floor(maxErrorChars / 2)
		const errorText = rawError.length > maxErrorChars
			? `${rawError.slice(0, errorHeadChars)}${rawError.slice(-errorTailChars)}`
			: rawError
		notify("complete", {
			...(error && !exited ? { error: errorText } : {}),
		})
		hostSetImmediate(() => exitProcess(0))
	}
	const start = (params) => {
		if (started) throw new Error("code-mode runner was already started")
		started = true
		maxErrorChars = params.maxOutputChars
		let cell
		try {
			cell = createCell(params, { wake: schedulePump })
			bridge = cell.bridge
		} catch (error) {
			finish(error)
			return
		}
		drainOutbox()
		schedulePump()
		HostPromise.resolve(cell.execution).then(() => finish(), finish)
	}
	const handleMessage = (message) => {
		if (hostHasOwn(message, "result") || hostHasOwn(message, "error")) {
			const target = pending.get(message.id)
			if (!target) return
			pending.delete(message.id)
			if (message.error) target.reject(hostAssign(new HostError(message.error.message || HostString(message.error)), message.error))
			else target.resolve(message.result)
			return
		}
		if (message.method === "start") start(message.params)
		else if (message.method === "reset_output") bridge?.resetOutputBudget()
		else if (message.method === "terminate") exitProcess(0)
	}

	const reader = createInterface({ input: hostInput })
	reader.on("line", (line) => {
		try {
			if (line.trim()) handleMessage(hostJsonParse(line))
		} catch (error) {
			finish(error)
		}
	})
	reader.on("close", () => exitProcess(0))
}
