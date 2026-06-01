// Stateful wrapper around the agent loop. Owns the transcript, queues for
// steering and follow-up messages, abort signals, and event subscriptions.

import { emptyUsage } from "../ai-apis/usage.js"
import { nextAgentAction, runAgentLoop, runAgentLoopContinue } from "./agent-loop.js"
import { streamSimple as defaultStreamFn } from "./stream-adapter.js"

/** @typedef {import("./types.js").AgentEvent} AgentEvent */
/** @typedef {import("./types.js").AgentMessage} AgentMessage */
/** @typedef {import("./types.js").AgentTool} AgentTool */
/** @typedef {import("./types.js").Model} Model */
/** @typedef {import("./types.js").ThinkingLevel} ThinkingLevel */
/** @typedef {import("./types.js").ToolExecutionMode} ToolExecutionMode */
/** @typedef {"all" | "one-at-a-time"} QueueMode */

const EMPTY_USAGE = emptyUsage()

const DEFAULT_MODEL = {
	id: "unknown",
	name: "unknown",
	provider: "unknown",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 0,
	maxTokens: 0,
}

function defaultConvertToLlm(messages) {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult")
}

class PendingMessageQueue {
	/** @param {QueueMode} mode */
	constructor(mode) {
		this.mode = mode
		/** @type {AgentMessage[]} */
		this.messages = []
	}
	enqueue(message) {
		this.messages.push(message)
	}
	hasItems() {
		return this.messages.length > 0
	}
	drain() {
		if (this.mode === "all") {
			const drained = this.messages.slice()
			this.messages = []
			return drained
		}
		const first = this.messages[0]
		if (!first) return []
		this.messages = this.messages.slice(1)
		return [first]
	}
	peek() {
		return this.messages.slice()
	}
	clear() {
		this.messages = []
	}
}

function createMutableAgentState(initialState) {
	let tools = initialState?.tools?.slice() ?? []
	let messages = initialState?.messages?.slice() ?? []
	return {
		systemPrompt: initialState?.systemPrompt ?? "",
		model: initialState?.model ?? DEFAULT_MODEL,
		thinkingLevel: initialState?.thinkingLevel ?? "high",
		serviceTier: initialState?.serviceTier,
		get tools() {
			return tools
		},
		set tools(next) {
			tools = next.slice()
		},
		get messages() {
			return messages
		},
		set messages(next) {
			messages = next.slice()
		},
		isStreaming: false,
		streamingMessage: undefined,
		currentModelRequest: undefined,
		pendingToolCalls: new Set(),
		errorMessage: undefined,
	}
}

export class Agent {
	constructor(options = {}) {
		this._state = createMutableAgentState(options.initialState)
		/** @type {Set<(event: AgentEvent, signal: AbortSignal) => void | Promise<void>>} */
		this.listeners = new Set()
		/** Parallel listener channel for compaction events. Separate from
		 * `listeners` because compaction can happen outside an active run
		 * (manual /compact runs between turns) and isn't a streaming-loop
		 * event the AbortSignal-bound dispatcher is designed for.
		 * @type {Set<(message: any) => void | Promise<void>>} */
		this.compactionListeners = new Set()
		/** Maps in-memory messages to their session storage entry IDs.
		 * Populated by interactive/RPC frontends — both on replay
		 * (from the entry IDs returned by Session.getLogicalEntries) and
		 * live (from Session.appendMessage's return value). Read by
		 * `compact()` to resolve which entry ID bounds the elided prefix.
		 * @type {WeakMap<object, string>} */
		this.msgToEntryId = new WeakMap()
		/** Optional session reference. Set by the frontend after opening
		 * or switching sessions. `compact()` uses it to persist the
		 * compaction operation as a custom entry so its effect survives
		 * resume. When null, compaction stays in-memory only.
		 * @type {import("../session-manager/session.js").Session | null} */
		this.session = null
		this.steeringQueue = new PendingMessageQueue(options.steeringMode ?? "one-at-a-time")
		this.followUpQueue = new PendingMessageQueue(options.followUpMode ?? "one-at-a-time")

		this.convertToLlm = options.convertToLlm ?? defaultConvertToLlm
		this.transformContext = options.transformContext
		this.streamFn = options.streamFn ?? defaultStreamFn
		this.getApiKey = options.getApiKey
		this.onPayload = options.onPayload
		this.onResponse = options.onResponse
		this.beforeToolCall = options.beforeToolCall
		this.afterToolCall = options.afterToolCall
		this.automatedFollowUp = options.automatedFollowUp
		/** Optional app-level hook for durable context-load entries. Agent core does not emit these itself; Pinano's lazy context loader calls it after recording a context entry. @type {((entry: any) => void | Promise<void>) | undefined} */
		this.onContextLoad = options.onContextLoad

		this.sessionId = options.sessionId
		this.toolExecution = options.toolExecution ?? "parallel"

		/** @type {{ token: symbol, promise: Promise<void>, resolve: () => void, abortController: AbortController } | undefined} */
		this.activeRun = undefined
		/** @type {Promise<void> | undefined} */
		this.sidecarRun = undefined
		this.softStopRequested = false
	}

	/**
	 * Subscribe to agent lifecycle events. Listener promises are awaited in
	 * subscription order. Returns an unsubscribe function.
	 * @param {(event: AgentEvent, signal: AbortSignal) => void | Promise<void>} listener
	 */
	subscribe(listener) {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	/**
	 * Subscribe to compaction events. The callback receives the compaction
	 * marker message after `compact()` has rewritten state. Used by the TUI
	 * to render a divider in the live transcript so the user sees that
	 * compaction happened (otherwise it's silent — auto-compact in
	 * particular gives no other indication).
	 * @param {(message: any) => void | Promise<void>} listener
	 */
	subscribeCompaction(listener) {
		this.compactionListeners.add(listener)
		return () => this.compactionListeners.delete(listener)
	}

	/** @param {any} message */
	async notifyCompaction(message) {
		for (const listener of this.compactionListeners) {
			await listener(message)
		}
	}

	get state() {
		return this._state
	}

	set steeringMode(mode) {
		this.steeringQueue.mode = mode
	}
	get steeringMode() {
		return this.steeringQueue.mode
	}

	set followUpMode(mode) {
		this.followUpQueue.mode = mode
	}
	get followUpMode() {
		return this.followUpQueue.mode
	}

	watchMessageEnd(message) {
		/** @type {() => void} */
		let unsubscribe = () => {}
		const promise = new Promise((resolve) => {
			unsubscribe = this.subscribe((event) => {
				if (event.type !== "message_end" || event.message !== message) return
				unsubscribe()
				resolve(undefined)
			})
		})
		return { promise, unsubscribe }
	}

	waitForMessagesAccepted(messages, run) {
		const watchers = messages.map((message) => this.watchMessageEnd(message))
		const accepted = Promise.all(watchers.map((watcher) => watcher.promise)).then(() => undefined)
		run.finally(() => watchers.forEach((watcher) => watcher.unsubscribe())).catch(() => {})
		return Promise.race([accepted, run.then(() => undefined)])
	}

	steer(message) {
		this.steeringQueue.enqueue(message)
	}

	followUp(message) {
		this.followUpQueue.enqueue(message)
	}

	clearSteeringQueue() {
		this.steeringQueue.clear()
	}

	clearFollowUpQueue() {
		this.followUpQueue.clear()
	}

	clearAllQueues() {
		this.clearSteeringQueue()
		this.clearFollowUpQueue()
	}

	hasQueuedMessages() {
		return this.steeringQueue.hasItems() || this.followUpQueue.hasItems()
	}

	getQueuedMessages() {
		return [
			...this.steeringQueue.peek().map((message) => ({ behavior: "steer", message })),
			...this.followUpQueue.peek().map((message) => ({ behavior: "followUp", message })),
		]
	}

	get signal() {
		return this.activeRun?.abortController.signal
	}

	abort() {
		this.activeRun?.abortController.abort()
	}

	softInterrupt() {
		if (!this.activeRun) return "idle"
		this.softStopRequested = true
		return this._state.pendingToolCalls.size > 0 ? "waiting_for_tools" : "waiting_for_model_stream"
	}

	waitForIdle() {
		return this.activeRun?.promise ?? this.sidecarRun ?? Promise.resolve()
	}

	reset() {
		this._state.messages = []
		this._state.isStreaming = false
		this._state.streamingMessage = undefined
		this._state.currentModelRequest = undefined
		this._state.pendingToolCalls = new Set()
		this._state.errorMessage = undefined
		this.clearFollowUpQueue()
		this.clearSteeringQueue()
	}

	/**
	 * Start a new prompt without awaiting the full run. `accepted` resolves once
	 * the initial user message(s) have entered the transcript, while `run`
	 * resolves when the agent is idle again.
	 * @param {string | AgentMessage | AgentMessage[]} input
	 * @param {any[]} [images]
	 */
	startPrompt(input, images) {
		if (this.activeRun) {
			throw new Error(
				"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
			)
		}
		const messages = this.normalizePromptInput(input, images)
		const watchers = messages.map((message) => this.watchMessageEnd(message))
		const accepted = Promise.all(watchers.map((watcher) => watcher.promise)).then(() => undefined)
		const run = this.runPromptMessages(messages)
		run.finally(() => watchers.forEach((watcher) => watcher.unsubscribe())).catch(() => {})
		return {
			messages,
			accepted: Promise.race([accepted, run.then(() => undefined)]),
			run,
		}
	}

	/**
	 * Start a new prompt. `input` may be a string, a single message, or an array.
	 * @param {string | AgentMessage | AgentMessage[]} input
	 * @param {any[]} [images]
	 */
	async prompt(input, images) {
		const { accepted, run } = this.startPrompt(input, images)
		accepted.catch(() => {})
		await run
	}

	async continue() {
		if (this.activeRun) {
			throw new Error("Agent is already processing. Wait for completion before continuing.")
		}
		const last = this._state.messages[this._state.messages.length - 1]
		if (!last) throw new Error("No messages to continue from")

		if (last.role === "assistant" && nextAgentAction(this._state.messages).type !== "execute_tool_calls") {
			const queuedSteering = this.steeringQueue.drain()
			if (queuedSteering.length > 0) {
				await this.runPromptMessages(queuedSteering, { skipInitialSteeringPoll: true })
				return
			}
			const queuedFollowUps = this.followUpQueue.drain()
			if (queuedFollowUps.length > 0) {
				await this.runPromptMessages(queuedFollowUps)
				return
			}
		}
		await this.runContinuation()
	}

	normalizePromptInput(input, images) {
		if (Array.isArray(input)) return input
		if (typeof input !== "string") return [input]
		const content = [{ type: "text", text: input }]
		if (images && images.length > 0) content.push(...images)
		return [{ role: "user", content, timestamp: Date.now() }]
	}

	async runPromptMessages(messages, options = {}) {
		await this.runWithLifecycle(async (signal, runToken) => {
			await runAgentLoop(
				messages,
				this.createContextSnapshot(),
				this.createLoopConfig(options),
				(event) => this.processEvents(event, runToken),
				signal,
				this.streamFn,
			)
		})
	}

	async runContinuation() {
		await this.runWithLifecycle(async (signal, runToken) => {
			await runAgentLoopContinue(
				this.createContextSnapshot(),
				this.createLoopConfig(),
				(event) => this.processEvents(event, runToken),
				signal,
				this.streamFn,
			)
		})
	}

	/**
	 * Run an agent-loop invocation against a snapshot of the current context
	 * without appending its messages to the durable/live conversation. This is
	 * for Pinano-owned sidecar work that should use the same model/tool
	 * execution machinery as a normal turn
	 * but must not become part of the user-visible session tree.
	 *
	 * @param {string | AgentMessage | AgentMessage[]} input
	 * @param {{ tools?: AgentTool[], signal?: AbortSignal, sessionId?: string, transformContext?: any, onEvent?: (event: AgentEvent) => void | Promise<void> }} [options]
	 */
	async runSidecarPrompt(input, options = {}) {
		const messages = this.normalizePromptInput(input)
		const context = {
			...this.createContextSnapshot(),
			tools: options.tools ?? this._state.tools.slice(),
		}
		const baseConfig = this.createLoopConfig()
		const config = {
			...baseConfig,
			sessionId: options.sessionId ?? (this.sessionId ? `${this.sessionId}:sidecar` : undefined),
			transformContext: options.transformContext,
			getSteeringMessages: async () => [],
			getFollowUpMessages: async () => [],
			afterToolCall: async (ctx, signal) => {
				const after = await baseConfig.afterToolCall?.(ctx, signal)
				return { ...after, terminate: true }
			},
		}
		const run = runAgentLoop(
			messages,
			context,
			config,
			async (event) => options.onEvent?.(event),
			options.signal,
			this.streamFn,
		)
		this.sidecarRun = run
		try {
			await run
		} finally {
			if (this.sidecarRun === run) this.sidecarRun = undefined
		}
	}

	/**
	 * Create an independent Agent with the same model-facing configuration and
	 * an explicit conversation snapshot. App-level factories may override this
	 * to attach isolated tool executors, but the default keeps ordinary Agent
	 * tests and embedded uses working without special wiring.
	 * @param {{ messages: AgentMessage[], transformContext?: any, afterToolCall?: any }} options
	 */
	createSidecarAgent(options) {
		const sidecar = new Agent({
			initialState: {
				systemPrompt: this._state.systemPrompt,
				model: this._state.model,
				thinkingLevel: this._state.thinkingLevel,
				serviceTier: this._state.serviceTier,
				messages: options.messages,
				tools: this._state.tools.slice(),
			},
			streamFn: this.streamFn,
			convertToLlm: this.convertToLlm,
			transformContext: options.transformContext,
			getApiKey: this.getApiKey,
			onPayload: this.onPayload,
			onResponse: this.onResponse,
			beforeToolCall: this.beforeToolCall,
			afterToolCall: options.afterToolCall,
			automatedFollowUp: undefined,
			toolExecution: this.toolExecution,
		})
		sidecar.sessionId = this.sessionId
		sidecar.session = this.session
		sidecar.contextFilesDisabled = this.contextFilesDisabled
		sidecar.activeContextSnapshotFiles = this.activeContextSnapshotFiles?.slice?.() ?? []
		return sidecar
	}

	createContextSnapshot() {
		return {
			systemPrompt: this._state.systemPrompt,
			messages: this._state.messages.slice(),
			tools: this._state.tools.slice(),
		}
	}

	createLoopConfig(options = {}) {
		let skipInitialSteeringPoll = options.skipInitialSteeringPoll === true
		return {
			model: this._state.model,
			reasoning: this._state.thinkingLevel,
			serviceTier: this._state.serviceTier,
			sessionId: this.sessionId,
			onPayload: this.onPayload,
			onResponse: this.onResponse,
			toolExecution: this.toolExecution,
			beforeToolCall: this.beforeToolCall,
			afterToolCall: this.afterToolCall,
			convertToLlm: this.convertToLlm,
			transformContext: this.transformContext,
			getApiKey: this.getApiKey,
			getSteeringMessages: async () => {
				if (skipInitialSteeringPoll) {
					skipInitialSteeringPoll = false
					return []
				}
				return this.steeringQueue.drain()
			},
			getFollowUpMessages: async () => this.followUpQueue.drain(),
			shouldStopBeforeToolCalls: async () => this.softStopRequested,
			shouldStopAfterTurn: async (ctx) => {
				if (this.softStopRequested) return true
				if ((await options.shouldStopAfterTurn?.(ctx)) === true) return true
				const automated = await this.automatedFollowUp?.(ctx)
				for (const message of automated ?? []) this.followUpQueue.enqueue(message)
				return false
			},
		}
	}

	async runWithLifecycle(executor) {
		if (this.activeRun) {
			throw new Error("Agent is already processing.")
		}
		const token = Symbol("agent-run")
		const abortController = new AbortController()
		let resolvePromise = () => {}
		const promise = new Promise((resolve) => {
			resolvePromise = resolve
		})
		this.activeRun = { token, promise, resolve: resolvePromise, abortController }

		this._state.isStreaming = true
		this._state.streamingMessage = undefined
		this._state.currentModelRequest = undefined
		this._state.errorMessage = undefined

		try {
			await executor(abortController.signal, token)
		} catch (error) {
			await this.handleRunFailure(error, abortController.signal.aborted)
		} finally {
			this.finishRun()
		}
	}

	async handleRunFailure(error, aborted) {
		const failureMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			provider: this._state.model.provider,
			model: this._state.model.id,
			usage: EMPTY_USAGE,
			stopReason: aborted ? "aborted" : "error",
			errorMessage: error instanceof Error ? error.message : String(error),
			timestamp: Date.now(),
		}
		await this.processEvents({ type: "message_start", message: failureMessage })
		await this.processEvents({ type: "message_end", message: failureMessage })
		await this.processEvents({ type: "turn_end", message: failureMessage, toolResults: [] })
		await this.processEvents({ type: "agent_end", messages: [failureMessage] })
	}

	finishRun() {
		this._state.isStreaming = false
		this._state.streamingMessage = undefined
		this._state.currentModelRequest = undefined
		this._state.pendingToolCalls = new Set()
		this.activeRun?.resolve()
		this.activeRun = undefined
		this.softStopRequested = false
	}

	async processEvents(event, runToken = this.activeRun?.token) {
		const activeRun = this.activeRun
		if (!activeRun || runToken !== activeRun.token) {
			// Late event from a detached/backgrounded operation belonging to a
			// previous run. The run is over (or another run owns the agent now), so
			// drop it before it can mutate live state or reach session persistence.
			return
		}
		if (event.type === "agent_end" && this.softStopRequested) event = { ...event, interrupted: true }
		switch (event.type) {
			case "message_start":
				this._state.streamingMessage = event.message
				break
			case "message_update":
				this._state.streamingMessage = event.message
				break
			case "model_request_start":
				this._state.currentModelRequest = event.request
				break
			case "model_request_end":
				this._state.currentModelRequest = undefined
				break
			case "message_end":
				this._state.streamingMessage = undefined
				this._state.messages.push(event.message)
				break
			case "tool_execution_start": {
				const next = new Set(this._state.pendingToolCalls)
				next.add(event.toolCallId)
				this._state.pendingToolCalls = next
				break
			}
			case "tool_execution_end": {
				const next = new Set(this._state.pendingToolCalls)
				next.delete(event.toolCallId)
				this._state.pendingToolCalls = next
				break
			}
			case "turn_end":
				if (event.message.role === "assistant" && event.message.errorMessage) {
					this._state.errorMessage = event.message.errorMessage
				}
				break
			case "agent_end":
				this._state.isStreaming = false
				this._state.streamingMessage = undefined
				this._state.currentModelRequest = undefined
				break
		}

		const signal = activeRun.abortController.signal
		for (const listener of this.listeners) {
			await listener(event, signal)
		}
	}
}
