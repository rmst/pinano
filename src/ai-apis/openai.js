// OpenAI Chat Completions provider implemented with fetch — no SDK.
// Streams via SSE, emits the unified AssistantMessageEvent protocol,
// supports tool calls, reasoning_effort, and OpenAI-compatible servers
// (Ollama, vLLM, LM Studio, etc) via the `compat` field on Model.

import { AssistantMessageEventStream } from "./event-stream.js"
import { missingApiKeyMessage, providerConfiguredApiKey } from "./api-key.js"
import { validateMessageHistory } from "./message-history.js"
import { parseStreamingJson } from "./json-parse.js"
import { beginModelRequest, finishHttpAttempt, finishModelRequest, recordStreamEvent } from "./model-io-log.js"
import { retryableModelErrorDetails, retryableModelErrorFrom } from "./model-errors.js"
import {
	cancelResponseBody,
	fetchStreamingResponseWithRetries,
	firstStreamEventTimeoutMs,
	streamEventInactivityTimeoutMs,
	streamFailurePhase,
	streamInactivityTimeoutMs,
} from "./responses-transport.js"
import { sanitizeSurrogates } from "./sanitize-unicode.js"
import { parseSSE } from "./sse.js"
import { transformMessages } from "./transform-messages.js"
import { buildAssistantAuth, emptyUsage, normalizeChatUsage } from "./usage.js"

const DEFAULT_COMPAT = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	supportsStrictMode: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	supportsPromptCacheKey: true,
}

function resolveCompat(model) {
	const merged = { ...DEFAULT_COMPAT, ...(model.compat ?? {}) }
	// Auto-detect: only OpenAI's own host supports prompt_cache_key by default.
	if (model.compat?.supportsPromptCacheKey === undefined) {
		merged.supportsPromptCacheKey = !!model.baseUrl?.includes("api.openai.com")
	}
	return merged
}

function mapStopReason(reason) {
	if (reason == null) return { stopReason: "stop" }
	switch (reason) {
		case "stop":
		case "end":
			return { stopReason: "stop" }
		case "length":
			return { stopReason: "length" }
		case "function_call":
		case "tool_calls":
			return { stopReason: "toolUse" }
		case "content_filter":
			return { stopReason: "error", errorMessage: "Provider finish_reason: content_filter" }
		default:
			return { stopReason: "error", errorMessage: `Provider finish_reason: ${reason}` }
	}
}

function baseToolCallId(id) {
	return String(id ?? "").split("|")[0]
}

function functionToolCallIds(messages) {
	const ids = new Set()
	for (const msg of messages) {
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue
		for (const block of msg.content) {
			if (block?.type === "toolCall" && block.input === undefined) ids.add(baseToolCallId(block.id))
		}
	}
	return ids
}

function hasToolHistory(messages) {
	const callIds = functionToolCallIds(messages)
	if (callIds.size > 0) return true
	return messages.some((msg) => msg.role === "toolResult" && callIds.has(baseToolCallId(msg.toolCallId)))
}

function imageUrlPart(block) {
	const detail = block.detail === "original" ? "high" : (block.detail ?? "high")
	return {
		type: "image_url",
		image_url: { url: `data:${block.mimeType};base64,${block.data}`, detail },
	}
}

function systemLikeMessageContent(content) {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return content
		.filter((block) => block?.type === "text")
		.map((block) => block.text ?? "")
		.join("")
}

function convertMessages(model, context, compat) {
	const params = []
	const transformed = transformMessages(context.messages, model)
	const inputs = model.input ?? ["text"]
	const functionCallIds = functionToolCallIds(transformed)

	if (context.systemPrompt) {
		const role = model.reasoning && compat.supportsDeveloperRole ? "developer" : "system"
		params.push({ role, content: sanitizeSurrogates(context.systemPrompt) })
	}

	let lastRole = null

	for (let i = 0; i < transformed.length; i++) {
		const msg = transformed[i]

		if (compat.requiresAssistantAfterToolResult && lastRole === "toolResult" && msg.role === "user") {
			params.push({ role: "assistant", content: "I have processed the tool results." })
		}

		if (msg.role === "developer" || msg.role === "system") {
			const content = systemLikeMessageContent(msg.content)
			if (content) {
				const role = msg.role === "developer" && model.reasoning && compat.supportsDeveloperRole ? "developer" : "system"
				params.push({ role, content: sanitizeSurrogates(content) })
			}
			lastRole = msg.role
			continue
		}

		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				params.push({ role: "user", content: sanitizeSurrogates(msg.content) })
			} else {
				const parts = msg.content.map((item) =>
					item.type === "text" ? { type: "text", text: sanitizeSurrogates(item.text) } : imageUrlPart(item),
				)
				if (parts.length > 0) params.push({ role: "user", content: parts })
			}
			lastRole = "user"
			continue
		}

		if (msg.role === "assistant") {
			const assistantMsg = { role: "assistant", content: compat.requiresAssistantAfterToolResult ? "" : null }

			const textBlocks = msg.content.filter((b) => b.type === "text" && b.text.trim().length > 0)
			const text = textBlocks.map((b) => sanitizeSurrogates(b.text)).join("")
			if (text.length > 0) assistantMsg.content = text

			const toolCalls = msg.content.filter((b) => b.type === "toolCall" && b.input === undefined)
			if (toolCalls.length > 0) {
				assistantMsg.tool_calls = toolCalls.map((tc) => ({
					id: tc.id,
					type: "function",
					function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
				}))
			}

			const hasContent =
				assistantMsg.content !== null && assistantMsg.content !== undefined && assistantMsg.content.length > 0
			if (!hasContent && !assistantMsg.tool_calls) {
				lastRole = "assistant"
				continue
			}
			params.push(assistantMsg)
			lastRole = "assistant"
			continue
		}

		if (msg.role === "toolResult") {
			const imageBlocks = []
			let pushedToolResult = false
			let j = i
			for (; j < transformed.length && transformed[j].role === "toolResult"; j++) {
				const tr = transformed[j]
				if (!functionCallIds.has(baseToolCallId(tr.toolCallId))) continue
				pushedToolResult = true
				const text = tr.content
					.filter((b) => b.type === "text")
					.map((b) => b.text)
					.join("\n")
				const hasImages = tr.content.some((b) => b.type === "image")
				const toolMsg = {
					role: "tool",
					content: sanitizeSurrogates(text.length > 0 ? text : "(see attached image)"),
					tool_call_id: tr.toolCallId,
				}
				if (compat.requiresToolResultName && tr.toolName) toolMsg.name = tr.toolName
				params.push(toolMsg)

				if (hasImages && inputs.includes("image")) {
					for (const block of tr.content) {
						if (block.type === "image") {
							imageBlocks.push(imageUrlPart(block))
						}
					}
				}
			}
			i = j - 1
			if (!pushedToolResult) continue

			if (imageBlocks.length > 0) {
				if (compat.requiresAssistantAfterToolResult) {
					params.push({ role: "assistant", content: "I have processed the tool results." })
				}
				params.push({
					role: "user",
					content: [{ type: "text", text: "Attached image(s) from tool result:" }, ...imageBlocks],
				})
				lastRole = "user"
			} else {
				lastRole = "toolResult"
			}
			continue
		}
	}

	return params
}

function convertTools(tools, compat) {
	return tools.filter((tool) => tool.kind !== "custom").map((tool) => {
		const def = {
			type: "function",
			function: {
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			},
		}
		if (compat.supportsStrictMode) def.function.strict = false
		return def
	})
}

function buildPayload(model, context, options, compat) {
	const messages = convertMessages(model, context, compat)
	const payload = { model: model.id, messages, stream: true }

	if (compat.supportsUsageInStreaming) {
		payload.stream_options = { include_usage: true }
	}
	if (compat.supportsStore) payload.store = false

	if (options?.maxTokens != null) {
		const field = compat.maxTokensField === "max_tokens" ? "max_tokens" : "max_completion_tokens"
		payload[field] = options.maxTokens
	}
	if (options?.temperature !== undefined) payload.temperature = options.temperature

	if (context.tools && context.tools.length > 0) {
		payload.tools = convertTools(context.tools, compat)
	} else if (hasToolHistory(context.messages)) {
		payload.tools = []
	}

	if (options?.toolChoice) payload.tool_choice = options.toolChoice

	if (options?.reasoningEffort && model.reasoning && compat.supportsReasoningEffort) {
		payload.reasoning_effort = options.reasoningEffort
	}

	if (compat.supportsPromptCacheKey && options?.sessionId) {
		payload.prompt_cache_key = options.sessionId
	}

	return payload
}

function buildHeaders(model, apiKey, optionsHeaders) {
	const headers = {
		"Content-Type": "application/json",
		Accept: "text/event-stream",
		...(model.headers ?? {}),
	}
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`
	if (optionsHeaders) Object.assign(headers, optionsHeaders)
	return headers
}

function buildUrl(baseUrl) {
	const trimmed = baseUrl.replace(/\/+$/, "")
	return `${trimmed}/chat/completions`
}

/**
 * Open a streaming chat completion. Returns an AssistantMessageEventStream.
 * Errors are emitted as `error` events and reflected in the final message,
 * not thrown from this function.
 */
export function streamOpenAI(model, context, options) {
	const stream = new AssistantMessageEventStream()

	;(async () => {
		const output = {
			role: "assistant",
			content: [],
			provider: model.provider ?? "openai",
			model: model.id,
			auth: buildAssistantAuth(model, options),
			usage: emptyUsage(model),
			stopReason: "stop",
			timestamp: Date.now(),
		}

		let modelLog = null
		let attemptLog = null
		let attemptFinished = false
		let cleanupResponseSignal = () => {}
		let abortResponseSignal = () => {}
		let response
		try {
			validateMessageHistory(context.messages)
			const apiKey = options?.apiKey ?? providerConfiguredApiKey(model) ?? ""
			if (!apiKey) throw new Error(missingApiKeyMessage(model))
			const compat = resolveCompat(model)
			let payload = buildPayload(model, context, options, compat)
			if (options?.onPayload) {
				const next = await options.onPayload(payload, model)
				if (next !== undefined) payload = next
			}

			const url = buildUrl(model.baseUrl)
			const headers = buildHeaders(model, apiKey, options?.headers)
			const bodyJson = JSON.stringify(payload)
			modelLog = beginModelRequest({ model, transport: "chat", requestJson: bodyJson, options })
			if (modelLog?.id) output.modelRequestId = modelLog.id

			const {
				response: fetchedResponse,
				attemptLog: successAttemptLog,
				cleanupResponseSignal: cleanupFetchedResponseSignal,
				abortResponseSignal: abortFetchedResponseSignal,
			} = await fetchStreamingResponseWithRetries({
				url,
				headers,
				bodyJson,
				signal: options?.signal,
				model,
				modelLog,
				onResponse: options?.onResponse,
				parseError: async (text, status) => {
					let detail = text
					try {
						const json = JSON.parse(text)
						detail = json.error?.message || json.message || text
					} catch {}
					return { message: `HTTP ${status}: ${detail}` }
				},
				responseHeaderTimeoutMs: options?.responseHeaderTimeoutMs,
			})
			response = fetchedResponse
			attemptLog = successAttemptLog
			cleanupResponseSignal = cleanupFetchedResponseSignal
			abortResponseSignal = abortFetchedResponseSignal

			stream.push({ type: "start", partial: output })

			let currentBlock = null
			const blocks = output.content
			const indexOf = (block) => (block ? blocks.indexOf(block) : -1)
			const finishCurrentBlock = (block) => {
				if (!block) return
				const idx = indexOf(block)
				if (idx === -1) return
				if (block.type === "text") {
					stream.push({ type: "text_end", contentIndex: idx, content: block.text, partial: output })
				} else if (block.type === "thinking") {
					stream.push({ type: "thinking_end", contentIndex: idx, content: block.thinking, partial: output })
				} else if (block.type === "toolCall") {
					block.arguments = parseStreamingJson(block.partialArgs)
					delete block.partialArgs
					delete block.streamIndex
					stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: block, partial: output })
				}
			}

			for await (const chunk of parseSSE(response.body, {
				inactivityTimeoutMs: streamInactivityTimeoutMs(model, options?.streamInactivityTimeoutMs),
				firstEventTimeoutMs: firstStreamEventTimeoutMs(model, options?.firstStreamEventTimeoutMs),
				eventInactivityTimeoutMs: streamEventInactivityTimeoutMs(model, options?.streamEventInactivityTimeoutMs, options?.streamInactivityTimeoutMs),
				onEvent: (event) => recordStreamEvent(modelLog, attemptLog, event),
			})) {
				if (!chunk || typeof chunk !== "object") continue

				if (typeof chunk.id === "string" && !output.responseId) output.responseId = chunk.id
				if (typeof chunk.model === "string" && chunk.model.length > 0 && chunk.model !== model.id) {
					if (!output.responseModel) output.responseModel = chunk.model
				}
				if (chunk.usage) output.usage = normalizeChatUsage(chunk.usage, model)

				const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined
				if (!choice) continue

				if (!chunk.usage && choice.usage) output.usage = normalizeChatUsage(choice.usage, model)

				if (choice.finish_reason) {
					const result = mapStopReason(choice.finish_reason)
					output.stopReason = result.stopReason
					if (result.errorMessage) output.errorMessage = result.errorMessage
				}

				const delta = choice.delta
				if (!delta) continue

				if (typeof delta.content === "string" && delta.content.length > 0) {
					if (!currentBlock || currentBlock.type !== "text") {
						finishCurrentBlock(currentBlock)
						currentBlock = { type: "text", text: "" }
						output.content.push(currentBlock)
						stream.push({ type: "text_start", contentIndex: indexOf(currentBlock), partial: output })
					}
					currentBlock.text += delta.content
					stream.push({
						type: "text_delta",
						contentIndex: indexOf(currentBlock),
						delta: delta.content,
						partial: output,
					})
				}

				// Reasoning fields used by various OpenAI-compatible servers.
				let reasoningField = null
				for (const f of ["reasoning_content", "reasoning", "reasoning_text"]) {
					if (typeof delta[f] === "string" && delta[f].length > 0) {
						reasoningField = f
						break
					}
				}
				if (reasoningField) {
					if (!currentBlock || currentBlock.type !== "thinking") {
						finishCurrentBlock(currentBlock)
						currentBlock = { type: "thinking", thinking: "", thinkingSignature: reasoningField }
						output.content.push(currentBlock)
						stream.push({ type: "thinking_start", contentIndex: indexOf(currentBlock), partial: output })
					}
					const text = delta[reasoningField]
					currentBlock.thinking += text
					stream.push({
						type: "thinking_delta",
						contentIndex: indexOf(currentBlock),
						delta: text,
						partial: output,
					})
				}

				if (Array.isArray(delta.tool_calls)) {
					for (const tc of delta.tool_calls) {
						const streamIndex = typeof tc.index === "number" ? tc.index : undefined
						const sameToolCall =
							currentBlock?.type === "toolCall" &&
							((streamIndex !== undefined && currentBlock.streamIndex === streamIndex) ||
								(streamIndex === undefined && tc.id && currentBlock.id === tc.id))

						if (!sameToolCall) {
							finishCurrentBlock(currentBlock)
							currentBlock = {
								type: "toolCall",
								id: tc.id || "",
								name: tc.function?.name || "",
								arguments: {},
								partialArgs: "",
								streamIndex,
							}
							output.content.push(currentBlock)
							stream.push({ type: "toolcall_start", contentIndex: indexOf(currentBlock), partial: output })
						}

						if (currentBlock?.type === "toolCall") {
							if (!currentBlock.id && tc.id) currentBlock.id = tc.id
							if (!currentBlock.name && tc.function?.name) currentBlock.name = tc.function.name
							if (currentBlock.streamIndex === undefined && streamIndex !== undefined) {
								currentBlock.streamIndex = streamIndex
							}
							let chunkDelta = ""
							if (tc.function?.arguments) {
								chunkDelta = tc.function.arguments
								currentBlock.partialArgs += tc.function.arguments
								currentBlock.arguments = parseStreamingJson(currentBlock.partialArgs)
							}
							stream.push({
								type: "toolcall_delta",
								contentIndex: indexOf(currentBlock),
								delta: chunkDelta,
								partial: output,
							})
						}
					}
				}
			}

			finishCurrentBlock(currentBlock)
			finishHttpAttempt(attemptLog, { status: "completed" })
			attemptFinished = true
			cleanupResponseSignal()

			if (options?.signal?.aborted) throw new Error("Request was aborted")
			if (output.stopReason === "error") {
				throw new Error(output.errorMessage || "Provider returned an error stop reason")
			}

			finishModelRequest(modelLog, { status: "completed", finalMessage: output })
			stream.push({ type: "done", reason: output.stopReason, message: output })
			stream.end()
		} catch (error) {
			if (error?.name === "StreamInactivityTimeoutError" || error?.name === "StreamEventTimeoutError") {
				abortResponseSignal(error)
			}
			await cancelResponseBody(response, error)
			cleanupResponseSignal()
			const retryableError = options?.signal?.aborted
				? undefined
				: retryableModelErrorFrom(error, { phase: attemptLog && !attemptFinished ? streamFailurePhase(error) : undefined })
			const finalError = retryableError ?? error
			if (attemptLog && !attemptFinished) {
				finishHttpAttempt(attemptLog, {
					status: options?.signal?.aborted ? "aborted" : "stream_error",
					error: finalError instanceof Error ? finalError.message : JSON.stringify(finalError),
				})
			}
			for (const block of output.content) {
				delete block.partialArgs
				delete block.streamIndex
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error"
			output.errorMessage = finalError instanceof Error ? finalError.message : JSON.stringify(finalError)
			const errorDetails = retryableModelErrorDetails(finalError)
			if (errorDetails) output.errorDetails = errorDetails
			finishModelRequest(modelLog, { status: output.stopReason, finalMessage: output, error: output.errorMessage })
			stream.push({ type: "error", reason: output.stopReason, error: output })
			stream.end()
		}
	})()

	return stream
}

/**
 * Convenience wrapper: streams to completion and returns the final
 * AssistantMessage.
 */
export async function completeOpenAI(model, context, options) {
	const s = streamOpenAI(model, context, options)
	return s.result()
}
