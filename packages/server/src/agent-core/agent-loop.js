// Stateless agent loop. Drives one or more LLM turns, executes tool calls
// (sequentially or in parallel), and emits a stream of `AgentEvent`s.
//
// Ported from pi-mono `packages/agent/src/agent-loop.ts`. Same control flow,
// JS instead of TS, no typebox.

import { EventStream, validateToolArguments } from "../ai-apis/index.js"
import { streamSimple as defaultStreamFn } from "./stream-adapter.js"
import { isUncertainToolExecutionError } from "./tool-errors.js"

const CODEX_FAST_SERVICE_TIER_MODEL_IDS = new Set(["gpt-5.5", "gpt-5.6-sol"])

/** @typedef {import("./types.js").AgentContext} AgentContext */
/** @typedef {import("./types.js").AgentEvent} AgentEvent */
/** @typedef {import("./types.js").AgentLoopConfig} AgentLoopConfig */
/** @typedef {import("./types.js").AgentMessage} AgentMessage */
/** @typedef {import("./types.js").AgentTool} AgentTool */
/** @typedef {import("./types.js").AgentToolCall} AgentToolCall */
/** @typedef {import("./types.js").StreamFn} StreamFn */

/**
 * @callback AgentEventSink
 * @param {AgentEvent} event
 * @returns {void | Promise<void>}
 */

function createAgentStream() {
	return new EventStream(
		(event) => event.type === "agent_end",
		(event) => (event.type === "agent_end" ? event.messages : []),
	)
}

/** @param {AgentMessage | undefined} message */
function toolCallsOf(message) {
	return message?.role === "assistant" && Array.isArray(message.content)
		? message.content.filter((c) => c?.type === "toolCall")
		: []
}

/**
 * If the transcript ends in an assistant tool-call turn plus zero or more
 * toolResults, return the still-unanswered tool-call IDs. This covers durable
 * recovery after only part of a sequential tool batch was persisted: the next
 * action is to execute the not-yet-answered calls, not to call the model with an
 * incomplete batch and not to repeat already answered side effects.
 * @param {AgentMessage[]} messages
 * @returns {{ message: AgentMessage, pendingToolCallIds: string[] } | undefined}
 */
function pendingToolBatch(messages) {
	let assistantIndex = messages.length - 1
	while (assistantIndex >= 0 && messages[assistantIndex]?.role === "toolResult") assistantIndex--
	const assistant = messages[assistantIndex]
	const toolCalls = toolCallsOf(assistant)
	if (toolCalls.length === 0) return undefined
	const answered = new Set(
		messages
			.slice(assistantIndex + 1)
			.filter((m) => m?.role === "toolResult")
			.map((m) => m.toolCallId),
	)
	const pendingToolCallIds = toolCalls.map((tc) => tc.id).filter((id) => id && !answered.has(id))
	return pendingToolCallIds.length > 0 ? { message: assistant, pendingToolCallIds } : undefined
}

/**
 * Derive the next executable agent action from durable conversation messages.
 * This is intentionally not resume-specific: normal /continue, service recovery,
 * and tests all ask the same state machine what can happen next.
 * @param {AgentMessage[]} messages
 * @returns {{ type: "call_model" } | { type: "execute_tool_calls", message: AgentMessage, pendingToolCallIds?: string[] } | { type: "wait_for_user", reason: string }}
 */
export function nextAgentAction(messages) {
	const last = messages[messages.length - 1]
	if (!last) return { type: "wait_for_user", reason: "empty" }
	if (last.role === "user") return { type: "call_model" }
	if (last.role === "assistant") {
		if (last.stopReason === "error" || last.stopReason === "aborted" || last.errorMessage) return { type: "wait_for_user", reason: "failed_assistant" }
		const pending = pendingToolBatch(messages)
		if (pending) return { type: "execute_tool_calls", ...pending }
		return { type: "wait_for_user", reason: "assistant_complete" }
	}
	if (last.role === "toolResult") {
		const pending = pendingToolBatch(messages)
		if (pending) return { type: "execute_tool_calls", ...pending }
		return { type: "call_model" }
	}
	return { type: "wait_for_user", reason: `unsupported_role:${last.role ?? "unknown"}` }
}

/**
 * Start an agent loop with a new prompt message.
 * @param {AgentMessage[]} prompts
 * @param {AgentContext} context
 * @param {AgentLoopConfig} config
 * @param {AbortSignal} [signal]
 * @param {StreamFn} [streamFn]
 */
export function agentLoop(prompts, context, config, signal, streamFn) {
	const stream = createAgentStream()
	void runAgentLoop(prompts, context, config, async (event) => stream.push(event), signal, streamFn).then(
		(messages) => stream.end(messages),
	)
	return stream
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries — context already ends with a user or tool-result message.
 * @param {AgentContext} context
 * @param {AgentLoopConfig} config
 * @param {AbortSignal} [signal]
 * @param {StreamFn} [streamFn]
 */
export function agentLoopContinue(context, config, signal, streamFn) {
	const action = nextAgentAction(context.messages)
	if (action.type === "wait_for_user") {
		throw new Error(`Cannot continue: ${action.reason}`)
	}
	const stream = createAgentStream()
	void runAgentLoopContinue(context, config, async (event) => stream.push(event), signal, streamFn).then(
		(messages) => stream.end(messages),
	)
	return stream
}

/**
 * @param {AgentMessage[]} prompts
 * @param {AgentContext} context
 * @param {AgentLoopConfig} config
 * @param {AgentEventSink} emit
 * @param {AbortSignal} [signal]
 * @param {StreamFn} [streamFn]
 * @returns {Promise<AgentMessage[]>}
 */
export async function runAgentLoop(prompts, context, config, emit, signal, streamFn) {
	const newMessages = [...prompts]
	const currentContext = { ...context, messages: [...context.messages, ...prompts] }

	await emit({ type: "agent_start" })
	await emit({ type: "turn_start" })
	for (const prompt of prompts) {
		await emit({ type: "message_start", message: prompt })
		await emit({ type: "message_end", message: prompt })
	}

	const preTurnMessages = (await config.getPreTurnMessages?.({ context: currentContext, newMessages })) || []
	await runLoop(currentContext, newMessages, config, signal, emit, streamFn, undefined, preTurnMessages.length > 0 ? preTurnMessages : undefined)
	return newMessages
}

/**
 * @param {AgentContext} context
 * @param {AgentLoopConfig} config
 * @param {AgentEventSink} emit
 * @param {AbortSignal} [signal]
 * @param {StreamFn} [streamFn]
 * @returns {Promise<AgentMessage[]>}
 */
export async function runAgentLoopContinue(context, config, emit, signal, streamFn) {
	const actionMessages = await config.projectMessagesForNextAction?.({ message: context.messages.at(-1), toolResults: [], context, newMessages: [] }) ?? context.messages
	const action = nextAgentAction(actionMessages)
	if (action.type === "wait_for_user") {
		throw new Error(`Cannot continue: ${action.reason}`)
	}
	const newMessages = []
	const currentContext = { ...context, messages: actionMessages }

	await emit({ type: "agent_start" })
	await emit({ type: "turn_start" })

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn, action)
	return newMessages
}

async function runLoop(currentContext, newMessages, config, signal, emit, streamFn, initialAction = undefined, initialPendingMessages = undefined) {
	let firstTurn = true
	let pendingMessages = initialPendingMessages ?? ((await config.getSteeringMessages?.()) || [])
	let pendingAction = initialAction
	let toolCallLimitCount = 0

	// signal.aborted is the single source of truth for stopping the loop:
	// every checkpoint *between* turns / phases routes through this exit so
	// we never start a new phase after the user has hit Esc. We deliberately
	// don't short-circuit before the very first stream call — even an
	// already-aborted signal should be handed to streamAssistantResponse so
	// the streamFn can report stopReason=aborted (matching pi/pre-existing
	// agent semantics where abort always produces an aborted assistant turn).
	const aborted = () => signal?.aborted === true
	const exitAborted = async () => {
		await emit({ type: "agent_end", messages: newMessages })
	}

	while (true) {
		let hasMoreToolCalls = true

		while (hasMoreToolCalls || pendingMessages.length > 0 || pendingAction) {
			if (!firstTurn) {
				if (aborted()) return exitAborted()
				await emit({ type: "turn_start" })
			} else {
				firstTurn = false
			}

			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					await emit({ type: "message_start", message })
					await emit({ type: "message_end", message })
					currentContext.messages.push(message)
					newMessages.push(message)
				}
				pendingMessages = []
			}

			let message
			let pendingToolCallIds
			if (pendingAction?.type === "execute_tool_calls") {
				message = pendingAction.message
				pendingToolCallIds = pendingAction.pendingToolCallIds
				pendingAction = undefined
			} else {
				pendingAction = undefined
				message = await streamAssistantResponse(currentContext, newMessages, config, signal, emit, streamFn)
				newMessages.push(message)
			}

			const maxToolCalls = normalizedMaxToolCalls(await config.maxToolCalls?.({
				message,
				context: currentContext,
				newMessages,
			}))
			const turn = await finishAssistantTurn(
				currentContext,
				newMessages,
				message,
				config,
				signal,
				emit,
				exitAborted,
				pendingToolCallIds,
				{ maxToolCalls, toolCallLimitCount },
			)
			if (turn.agentEnded) return
			toolCallLimitCount = maxToolCalls === undefined ? 0 : toolCallLimitCount + turn.toolResults.length
			hasMoreToolCalls = turn.hasMoreToolCalls
			pendingMessages = (await config.getSteeringMessages?.()) || []
			if (!hasMoreToolCalls) {
				const actionMessages = await config.projectMessagesForNextAction?.({
					message,
					toolResults: turn.toolResults,
					context: currentContext,
					newMessages,
				})
				if (actionMessages) {
					const action = nextAgentAction(actionMessages)
					if (action.type !== "wait_for_user") {
						currentContext.messages = actionMessages
						if (pendingMessages.length === 0) pendingAction = action
					}
				}
			}
		}

		if (aborted()) return exitAborted()

		const followUpMessages = (await config.getFollowUpMessages?.()) || []
		if (followUpMessages.length > 0) {
			pendingMessages = followUpMessages
			continue
		}
		break
	}

	await emit({ type: "agent_end", messages: newMessages })
}

function normalizedMaxToolCalls(value) {
	return Number.isInteger(value) && value >= 0 ? value : undefined
}

async function finishAssistantTurn(currentContext, newMessages, message, config, signal, emit, exitAborted, pendingToolCallIds = undefined, toolCallLimit = undefined) {
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		await emit({ type: "turn_end", message, toolResults: [] })
		await emit({ type: "agent_end", messages: newMessages })
		return { agentEnded: true, hasMoreToolCalls: false, toolResults: [] }
	}

	// Abort might have fired while the stream was completing successfully.
	if (signal?.aborted === true) {
		await emit({ type: "turn_end", message, toolResults: [] })
		await exitAborted()
		return { agentEnded: true, hasMoreToolCalls: false, toolResults: [] }
	}

	const toolCalls = toolCallsOf(message)
	const toolResults = []
	let hasMoreToolCalls = false
	if (toolCalls.length > 0) {
		if (await config.shouldStopBeforeToolCalls?.({ message, context: currentContext, newMessages })) {
			await emit({ type: "turn_end", message, toolResults })
			await emit({ type: "agent_end", messages: newMessages })
			return { agentEnded: true, hasMoreToolCalls: false, toolResults }
		}
		const batch = await executeToolCalls(currentContext, message, config, signal, emit, pendingToolCallIds)
		toolResults.push(...batch.messages)
		hasMoreToolCalls = !batch.terminate
		if (toolCallLimit?.maxToolCalls !== undefined && toolCallLimit.toolCallLimitCount + toolResults.length >= toolCallLimit.maxToolCalls) {
			hasMoreToolCalls = false
		}
		for (const result of toolResults) {
			currentContext.messages.push(result)
			newMessages.push(result)
		}
	}

	await emit({ type: "turn_end", message, toolResults })

	if (signal?.aborted === true) {
		await exitAborted()
		return { agentEnded: true, hasMoreToolCalls: false, toolResults }
	}

	if (
		await config.shouldStopAfterTurn?.({
			message,
			toolResults,
			context: currentContext,
			newMessages,
		})
	) {
		await emit({ type: "agent_end", messages: newMessages })
		return { agentEnded: true, hasMoreToolCalls: false, toolResults }
	}

	return { agentEnded: false, hasMoreToolCalls, toolResults }
}

function serviceTierForModel(model, serviceTier) {
	if (!serviceTier) return undefined
	if (model?.serviceTiers?.includes?.(serviceTier)) return serviceTier
	return model?.provider === "openai-codex" && serviceTier === "priority" && CODEX_FAST_SERVICE_TIER_MODEL_IDS.has(model?.id) ? serviceTier : undefined
}

function modelForRequest(context, newMessages, config) {
	const requested = config.modelForRequest?.({ model: config.model, context, newMessages })
	if (requested && typeof requested.then === "function") return requested.then((model) => model ?? config.model)
	return requested ?? config.model
}

const ABORTED_STREAM = Symbol("aborted-stream")
const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

function closeDetachedModelStream(response, finalMessage) {
	try {
		response?.end?.(finalMessage)
	} catch {}
}

function cloneJson(value, fallback) {
	if (value === undefined) return fallback
	try {
		return JSON.parse(JSON.stringify(value))
	} catch {
		return fallback
	}
}

function abortedAssistantMessage(config, requestModel, partialMessage) {
	return {
		role: "assistant",
		content: cloneJson(partialMessage?.content, []),
		provider: partialMessage?.provider ?? requestModel?.provider ?? config.model?.provider,
		model: partialMessage?.model ?? requestModel?.id ?? config.model?.id,
		auth: cloneJson(partialMessage?.auth, partialMessage?.auth),
		usage: cloneJson(partialMessage?.usage, EMPTY_USAGE),
		stopReason: "aborted",
		errorMessage: "Request was aborted",
		timestamp: Date.now(),
		modelRequestId: partialMessage?.modelRequestId,
		responseId: partialMessage?.responseId,
	}
}

async function abortable(promise, signal) {
	if (!signal) return promise
	if (signal.aborted) return ABORTED_STREAM
	let removeAbortListener = () => {}
	const aborted = new Promise((resolve) => {
		const onAbort = () => resolve(ABORTED_STREAM)
		signal.addEventListener("abort", onAbort, { once: true })
		removeAbortListener = () => signal.removeEventListener("abort", onAbort)
	})
	try {
		return await Promise.race([promise, aborted])
	} finally {
		removeAbortListener()
	}
}

async function nextStreamEvent(iterator, signal) {
	return abortable(iterator.next(), signal)
}

async function finishAbortedAssistantResponse(context, config, requestModel, response, partialMessage, addedPartial, emit) {
	const finalMessage = abortedAssistantMessage(config, requestModel, partialMessage)
	closeDetachedModelStream(response, finalMessage)
	if (addedPartial) {
		context.messages[context.messages.length - 1] = finalMessage
	} else {
		context.messages.push(finalMessage)
		await emit({ type: "message_start", message: { ...finalMessage } })
	}
	await emit({ type: "message_end", message: finalMessage })
	return finalMessage
}

async function streamAssistantResponse(context, newMessages, config, signal, emit, streamFn) {
	let messages = context.messages
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal)
	}
	const selectedModel = modelForRequest(context, newMessages, config)
	const requestModel = selectedModel && typeof selectedModel.then === "function" ? await selectedModel : selectedModel
	const llmMessages = await config.convertToLlm(messages)
	const llmContext = {
		systemPrompt: context.systemPrompt,
		messages: llmMessages,
		tools: context.tools,
	}
	const fn = streamFn || defaultStreamFn
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(requestModel.provider) : undefined) || config.apiKey

	const modelRequest = {
		startedAt: new Date().toISOString(),
		provider: requestModel?.provider,
		model: requestModel?.id,
		transport: requestModel?.transport,
	}
	await emit({ type: "model_request_start", request: modelRequest })

	let partialMessage = null
	let addedPartial = false
	let finalMessage
	let response

	try {
		const streamResult = fn(requestModel, llmContext, {
			reasoning: config.reasoning,
			serviceTier: serviceTierForModel(requestModel, config.serviceTier),
			sessionId: config.sessionId,
			auth: config.auth,
			onPayload: config.onPayload,
			onResponse: config.onResponse,
			apiKey: resolvedApiKey,
			signal,
		})
		const streamPromise = Promise.resolve(streamResult)
		response = signal?.aborted === true && typeof streamResult?.then !== "function"
			? streamResult
			: await abortable(streamPromise, signal)
		if (response === ABORTED_STREAM) {
			finalMessage = await finishAbortedAssistantResponse(context, config, requestModel, undefined, partialMessage, addedPartial, emit)
			streamPromise.then((lateResponse) => closeDetachedModelStream(lateResponse, finalMessage)).catch(() => {})
			return finalMessage
		}
		if (signal?.aborted === true) {
			finalMessage = await finishAbortedAssistantResponse(context, config, requestModel, response, partialMessage, addedPartial, emit)
			return finalMessage
		}

		const iterator = response[Symbol.asyncIterator]()
		while (true) {
			const next = await nextStreamEvent(iterator, signal)
			if (next === ABORTED_STREAM) {
				finalMessage = await finishAbortedAssistantResponse(context, config, requestModel, response, partialMessage, addedPartial, emit)
				return finalMessage
			}
			if (next.done) break
			const event = next.value
			switch (event.type) {
				case "start":
					partialMessage = event.partial
					context.messages.push(partialMessage)
					addedPartial = true
					await emit({ type: "message_start", message: { ...partialMessage } })
					break

				case "text_start":
				case "text_delta":
				case "text_end":
				case "thinking_start":
				case "thinking_delta":
				case "thinking_end":
				case "toolcall_start":
				case "toolcall_delta":
				case "toolcall_end":
					if (partialMessage) {
						partialMessage = event.partial
						context.messages[context.messages.length - 1] = partialMessage
						await emit({
							type: "message_update",
							assistantMessageEvent: event,
							message: { ...partialMessage },
						})
					}
					break

				case "done":
				case "error": {
					finalMessage = event.type === "done" ? event.message : event.error
					if (!finalMessage) finalMessage = await response.result()
					if (addedPartial) {
						context.messages[context.messages.length - 1] = finalMessage
					} else {
						context.messages.push(finalMessage)
					}
					if (!addedPartial) {
						await emit({ type: "message_start", message: { ...finalMessage } })
					}
					await emit({ type: "message_end", message: finalMessage })
					return finalMessage
				}
			}
		}

		if (signal?.aborted === true) {
			finalMessage = await finishAbortedAssistantResponse(context, config, requestModel, response, partialMessage, addedPartial, emit)
			return finalMessage
		}
		finalMessage = await response.result()
		if (addedPartial) {
			context.messages[context.messages.length - 1] = finalMessage
		} else {
			context.messages.push(finalMessage)
			await emit({ type: "message_start", message: { ...finalMessage } })
		}
		await emit({ type: "message_end", message: finalMessage })
		return finalMessage
	} finally {
		await emit({ type: "model_request_end", request: { ...modelRequest, modelRequestId: finalMessage?.modelRequestId } })
	}
}

async function executeToolCalls(currentContext, assistantMessage, config, signal, emit, pendingToolCallIds = undefined) {
	const pending = pendingToolCallIds ? new Set(pendingToolCallIds) : undefined
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall" && (!pending || pending.has(c.id)))
	const hasSequentialToolCall = toolCalls.some(
		(tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
	)
	if (config.toolExecution === "sequential" || hasSequentialToolCall) {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit)
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit)
}

async function executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit) {
	const finalizedCalls = []
	const messages = []

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: displayToolCallArgs(toolCall),
		})
		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal)
		let finalized
		if (preparation.kind === "immediate") {
			finalized = { toolCall, result: preparation.result, isError: preparation.isError }
		} else {
			const executed = await executePreparedToolCall(preparation, signal, emit)
			finalized = await finalizeExecutedToolCall(currentContext, assistantMessage, preparation, executed, config, signal)
		}
		await emitToolExecutionEnd(finalized, emit)
		const toolResultMessage = createToolResultMessage(finalized)
		await emitToolResultMessage(toolResultMessage, emit)
		finalizedCalls.push(finalized)
		messages.push(toolResultMessage)
	}

	return { messages, terminate: shouldTerminateToolBatch(finalizedCalls) }
}

async function executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit) {
	const finalizedCalls = []

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: displayToolCallArgs(toolCall),
		})
		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal)
		if (preparation.kind === "immediate") {
			const finalized = { toolCall, result: preparation.result, isError: preparation.isError }
			await emitToolExecutionEnd(finalized, emit)
			finalizedCalls.push(finalized)
			continue
		}
		finalizedCalls.push(async () => {
			const executed = await executePreparedToolCall(preparation, signal, emit)
			const finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			)
			await emitToolExecutionEnd(finalized, emit)
			return finalized
		})
	}

	const orderedFinalized = await Promise.all(
		finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
	)
	const messages = []
	for (const finalized of orderedFinalized) {
		const toolResultMessage = createToolResultMessage(finalized)
		await emitToolResultMessage(toolResultMessage, emit)
		messages.push(toolResultMessage)
	}
	return { messages, terminate: shouldTerminateToolBatch(orderedFinalized) }
}

function shouldTerminateToolBatch(finalizedCalls) {
	return finalizedCalls.length > 0 && finalizedCalls.every((f) => f.result.terminate === true)
}

function displayToolCallArgs(toolCall) {
	return toolCall.input ?? toolCall.arguments
}

function prepareToolCallArguments(tool, toolCall) {
	if (tool.kind === "custom") return toolCall
	if (!tool.prepareArguments) return toolCall
	const prepared = tool.prepareArguments(toolCall.arguments)
	if (prepared === toolCall.arguments) return toolCall
	return { ...toolCall, arguments: prepared }
}

async function prepareToolCall(currentContext, assistantMessage, toolCall, config, signal) {
	const tool = currentContext.tools?.find((t) => t.name === toolCall.name)
	if (!tool) {
		return {
			kind: "immediate",
			result: createErrorToolResult(`Tool ${toolCall.name} not found`),
			isError: true,
		}
	}
	try {
		const preparedToolCall = prepareToolCallArguments(tool, toolCall)
		const validatedArgs = validateToolArguments(tool, preparedToolCall)
		if (config.beforeToolCall) {
			const before = await config.beforeToolCall(
				{ assistantMessage, toolCall, args: validatedArgs, context: currentContext },
				signal,
			)
			if (before?.block) {
				return {
					kind: "immediate",
					result: createErrorToolResult(before.reason || "Tool execution was blocked"),
					isError: true,
				}
			}
		}
		return { kind: "prepared", toolCall, tool, args: validatedArgs }
	} catch (error) {
		return {
			kind: "immediate",
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		}
	}
}

async function executePreparedToolCall(prepared, signal, emit) {
	const updateEvents = []
	const realExecution = (async () => {
		try {
			const result = await prepared.tool.execute(prepared.toolCall.id, prepared.args, signal, (partialResult) => {
				updateEvents.push(
					Promise.resolve(
						emit({
							type: "tool_execution_update",
							toolCallId: prepared.toolCall.id,
							toolName: prepared.toolCall.name,
							args: prepared.args,
							partialResult,
						}),
					).catch(() => {}),
				)
			})
			await Promise.all(updateEvents)
			return { result, isError: false }
		} catch (error) {
			await Promise.all(updateEvents)
			if (isUncertainToolExecutionError(error)) throw error
			return {
				result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
				isError: true,
			}
		}
	})()
	// Race against signal: tools that ignore the AbortSignal mid-execution (e.g. fs/promises
	// readFile on a large file, or a bash process slow to die after SIGKILL) would otherwise
	// hold the parallel batch open via Promise.all in the caller. On abort we synthesize an
	// "Operation aborted" result and let the underlying execution finish in the background —
	// its emits land in agent.processEvents which silently drops them once the run has ended.
	if (signal?.aborted) {
		realExecution.catch(() => {})
		return {
			result: createErrorToolResult("Operation aborted"),
			isError: true,
		}
	}
	const abortPromise = new Promise((resolve) => {
		signal?.addEventListener("abort", () => resolve(null), { once: true })
	})
	const winner = await Promise.race([realExecution, abortPromise])
	if (winner !== null) return winner
	realExecution.catch(() => {})
	return {
		result: createErrorToolResult("Operation aborted"),
		isError: true,
	}
}

async function finalizeExecutedToolCall(currentContext, assistantMessage, prepared, executed, config, signal) {
	let result = executed.result
	let isError = executed.isError
	if (config.afterToolCall) {
		try {
			const after = await config.afterToolCall(
				{
					assistantMessage,
					toolCall: prepared.toolCall,
					args: prepared.args,
					result,
					isError,
					context: currentContext,
				},
				signal,
			)
			if (after) {
				result = {
					content: after.content ?? result.content,
					details: after.details ?? result.details,
					terminate: after.terminate ?? result.terminate,
				}
				isError = after.isError ?? isError
			}
		} catch (error) {
			result = createErrorToolResult(error instanceof Error ? error.message : String(error))
			isError = true
		}
	}
	return { toolCall: prepared.toolCall, result, isError }
}

function createErrorToolResult(message) {
	return { content: [{ type: "text", text: message }], details: {} }
}

async function emitToolExecutionEnd(finalized, emit) {
	await emit({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: finalized.result,
		isError: finalized.isError,
	})
}

function createToolResultMessage(finalized) {
	return {
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		content: finalized.result.content,
		details: finalized.result.details,
		isError: finalized.isError,
		timestamp: Date.now(),
	}
}

async function emitToolResultMessage(toolResultMessage, emit) {
	await emit({ type: "message_start", message: toolResultMessage })
	await emit({ type: "message_end", message: toolResultMessage })
}
