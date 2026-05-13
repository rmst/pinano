// Stateful wrapper around the agent loop. Owns the transcript, queues for
// steering and follow-up messages, abort signals, and event subscriptions.

import { runAgentLoop, runAgentLoopContinue } from "./agent-loop.js"
import { streamSimple as defaultStreamFn } from "./stream-adapter.js"

/** @typedef {import("./types.js").AgentEvent} AgentEvent */
/** @typedef {import("./types.js").AgentMessage} AgentMessage */
/** @typedef {import("./types.js").AgentTool} AgentTool */
/** @typedef {import("./types.js").Model} Model */
/** @typedef {import("./types.js").ThinkingLevel} ThinkingLevel */
/** @typedef {import("./types.js").ToolExecutionMode} ToolExecutionMode */
/** @typedef {"all" | "one-at-a-time"} QueueMode */

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

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
		thinkingLevel: initialState?.thinkingLevel ?? "off",
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
		pendingToolCalls: new Set(),
		errorMessage: undefined,
	}
}

export class Agent {
	constructor(options = {}) {
		this._state = createMutableAgentState(options.initialState)
		/** @type {Set<(event: AgentEvent, signal: AbortSignal) => void | Promise<void>>} */
		this.listeners = new Set()
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

		this.sessionId = options.sessionId
		this.toolExecution = options.toolExecution ?? "parallel"

		/** @type {{ promise: Promise<void>, resolve: () => void, abortController: AbortController } | undefined} */
		this.activeRun = undefined
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

	get signal() {
		return this.activeRun?.abortController.signal
	}

	abort() {
		this.activeRun?.abortController.abort()
	}

	waitForIdle() {
		return this.activeRun?.promise ?? Promise.resolve()
	}

	reset() {
		this._state.messages = []
		this._state.isStreaming = false
		this._state.streamingMessage = undefined
		this._state.pendingToolCalls = new Set()
		this._state.errorMessage = undefined
		this.clearFollowUpQueue()
		this.clearSteeringQueue()
	}

	/**
	 * Start a new prompt. `input` may be a string, a single message, or an array.
	 * @param {string | AgentMessage | AgentMessage[]} input
	 * @param {any[]} [images]
	 */
	async prompt(input, images) {
		if (this.activeRun) {
			throw new Error(
				"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
			)
		}
		const messages = this.normalizePromptInput(input, images)
		await this.runPromptMessages(messages)
	}

	async continue() {
		if (this.activeRun) {
			throw new Error("Agent is already processing. Wait for completion before continuing.")
		}
		const last = this._state.messages[this._state.messages.length - 1]
		if (!last) throw new Error("No messages to continue from")

		if (last.role === "assistant") {
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
			throw new Error("Cannot continue from message role: assistant")
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
		await this.runWithLifecycle(async (signal) => {
			await runAgentLoop(
				messages,
				this.createContextSnapshot(),
				this.createLoopConfig(options),
				(event) => this.processEvents(event),
				signal,
				this.streamFn,
			)
		})
	}

	async runContinuation() {
		await this.runWithLifecycle(async (signal) => {
			await runAgentLoopContinue(
				this.createContextSnapshot(),
				this.createLoopConfig(),
				(event) => this.processEvents(event),
				signal,
				this.streamFn,
			)
		})
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
			reasoning: this._state.thinkingLevel === "off" ? undefined : this._state.thinkingLevel,
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
		}
	}

	async runWithLifecycle(executor) {
		if (this.activeRun) {
			throw new Error("Agent is already processing.")
		}
		const abortController = new AbortController()
		let resolvePromise = () => {}
		const promise = new Promise((resolve) => {
			resolvePromise = resolve
		})
		this.activeRun = { promise, resolve: resolvePromise, abortController }

		this._state.isStreaming = true
		this._state.streamingMessage = undefined
		this._state.errorMessage = undefined

		try {
			await executor(abortController.signal)
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
		this._state.pendingToolCalls = new Set()
		this.activeRun?.resolve()
		this.activeRun = undefined
	}

	async processEvents(event) {
		switch (event.type) {
			case "message_start":
				this._state.streamingMessage = event.message
				break
			case "message_update":
				this._state.streamingMessage = event.message
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
				this._state.streamingMessage = undefined
				break
		}

		const signal = this.activeRun?.abortController.signal
		if (!signal) {
			throw new Error("Agent listener invoked outside active run")
		}
		for (const listener of this.listeners) {
			await listener(event, signal)
		}
	}
}
