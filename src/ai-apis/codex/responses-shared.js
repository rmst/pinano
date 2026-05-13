// Shared message conversion + stream processing for OpenAI's Responses API
// (the protocol Codex speaks). Different from Chat Completions:
//   - input is an array of typed items: messages, reasoning, function_call, function_call_output
//   - assistant content is split into "items": message / reasoning / function_call
//   - tool calls have both a call_id and an item id (we keep them as "call_id|item_id"
//     in our internal ToolCall.id for replay)
//   - streaming events are typed: response.output_item.added/done,
//     response.output_text.delta, response.function_call_arguments.delta, etc.
//
// Encrypted reasoning items are replayed verbatim by stashing the full item
// JSON in ThinkingContent.thinkingSignature. The textSignature carries the
// message id so the upstream model can pair text back to its previous turn.

import { parseStreamingJson } from "../json-parse.js"
import { sanitizeSurrogates } from "../sanitize-unicode.js"
import { transformMessages } from "../transform-messages.js"

// Fast deterministic hash to shorten long IDs to <=64 chars.
export function shortHash(str) {
	let h1 = 0xdeadbeef
	let h2 = 0x41c6ce57
	for (let i = 0; i < str.length; i++) {
		const ch = str.charCodeAt(i)
		h1 = Math.imul(h1 ^ ch, 2654435761)
		h2 = Math.imul(h2 ^ ch, 1597334677)
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
	return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36)
}

function encodeTextSignature(id, phase) {
	const payload = { v: 1, id }
	if (phase) payload.phase = phase
	return JSON.stringify(payload)
}

function parseTextSignature(signature) {
	if (!signature) return undefined
	if (signature.startsWith("{")) {
		try {
			const parsed = JSON.parse(signature)
			if (parsed.v === 1 && typeof parsed.id === "string") {
				if (parsed.phase === "commentary" || parsed.phase === "final_answer") {
					return { id: parsed.id, phase: parsed.phase }
				}
				return { id: parsed.id }
			}
		} catch {}
	}
	return { id: signature }
}

function normalizeIdPart(part) {
	const sanitized = part.replace(/[^a-zA-Z0-9_-]/g, "_")
	const trimmed = sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized
	return trimmed.replace(/_+$/, "")
}

// ============================================================================
// Message conversion: Context.messages -> Responses API `input` array
// ============================================================================

/**
 * Convert our Context to the Responses API `input` array.
 *
 * @param model - the codex model
 * @param context - { systemPrompt?, messages, tools? }
 * @param options - { includeSystemPrompt? } — Codex carries the system prompt
 *   in `instructions`, so set this to false there.
 */
export function convertResponsesMessages(model, context, options = {}) {
	const includeSystemPrompt = options.includeSystemPrompt ?? true
	const messages = []

	const transformedMessages = transformMessages(context.messages, model)

	if (includeSystemPrompt && context.systemPrompt) {
		const role = model.reasoning ? "developer" : "system"
		messages.push({ role, content: sanitizeSurrogates(context.systemPrompt) })
	}

	let msgIndex = 0
	for (const msg of transformedMessages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				messages.push({
					role: "user",
					content: [{ type: "input_text", text: sanitizeSurrogates(msg.content) }],
				})
			} else {
				const content = msg.content
					.map((item) =>
						item.type === "text"
							? { type: "input_text", text: sanitizeSurrogates(item.text) }
							: {
									type: "input_image",
									detail: "auto",
									image_url: `data:${item.mimeType};base64,${item.data}`,
								},
					)
				if (content.length === 0) continue
				messages.push({ role: "user", content })
			}
		} else if (msg.role === "assistant") {
			const output = []
			for (const block of msg.content) {
				if (block.type === "thinking") {
					if (block.thinkingSignature) {
						try {
							output.push(JSON.parse(block.thinkingSignature))
						} catch {
							// Bad signature — skip rather than corrupt the request.
						}
					}
				} else if (block.type === "text") {
					const parsedSig = parseTextSignature(block.textSignature)
					let msgId = parsedSig?.id
					if (!msgId) msgId = `msg_${msgIndex}`
					else if (msgId.length > 64) msgId = `msg_${shortHash(msgId)}`
					const item = {
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: sanitizeSurrogates(block.text), annotations: [] }],
						status: "completed",
						id: msgId,
					}
					if (parsedSig?.phase) item.phase = parsedSig.phase
					output.push(item)
				} else if (block.type === "toolCall") {
					const [callIdRaw, itemIdRaw] = block.id.split("|")
					const callId = normalizeIdPart(callIdRaw)
					let itemId = itemIdRaw ? normalizeIdPart(itemIdRaw) : undefined
					if (itemId && !itemId.startsWith("fc_")) itemId = normalizeIdPart(`fc_${itemId}`)
					output.push({
						type: "function_call",
						id: itemId,
						call_id: callId,
						name: block.name,
						arguments: JSON.stringify(block.arguments),
					})
				}
			}
			if (output.length === 0) continue
			messages.push(...output)
		} else if (msg.role === "toolResult") {
			const textResult = msg.content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("\n")
			const hasImages = msg.content.some((c) => c.type === "image")
			const hasText = textResult.length > 0
			const [callIdRaw] = msg.toolCallId.split("|")
			const callId = normalizeIdPart(callIdRaw)
			const inputs = model.input ?? ["text"]

			let output
			if (hasImages && inputs.includes("image")) {
				output = []
				if (hasText) output.push({ type: "input_text", text: sanitizeSurrogates(textResult) })
				for (const block of msg.content) {
					if (block.type === "image") {
						output.push({
							type: "input_image",
							detail: "auto",
							image_url: `data:${block.mimeType};base64,${block.data}`,
						})
					}
				}
			} else {
				output = sanitizeSurrogates(hasText ? textResult : "(see attached image)")
			}

			messages.push({ type: "function_call_output", call_id: callId, output })
		}
		msgIndex++
	}

	return messages
}

// ============================================================================
// Tools
// ============================================================================

export function convertResponsesTools(tools, options = {}) {
	const strict = options.strict === undefined ? false : options.strict
	return tools.map((tool) => ({
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		strict,
	}))
}

// ============================================================================
// Stream processing: Responses SSE events -> AssistantMessageEvent stream
// ============================================================================

function calculateCost(model, usage) {
	const cost = model.cost ?? {}
	usage.cost.input = ((cost.input ?? 0) / 1_000_000) * usage.input
	usage.cost.output = ((cost.output ?? 0) / 1_000_000) * usage.output
	usage.cost.cacheRead = ((cost.cacheRead ?? 0) / 1_000_000) * usage.cacheRead
	usage.cost.cacheWrite = ((cost.cacheWrite ?? 0) / 1_000_000) * usage.cacheWrite
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite
}

function mapStopReason(status) {
	if (!status) return "stop"
	switch (status) {
		case "completed":
			return "stop"
		case "incomplete":
			return "length"
		case "failed":
		case "cancelled":
			return "error"
		case "in_progress":
		case "queued":
			return "stop"
		default:
			return "stop"
	}
}

/**
 * Process a stream of Responses-shape SSE events. Mutates `output` and
 * pushes AssistantMessageEvents into `stream`. Caller is responsible for
 * pushing `start` before and `done`/`error` after.
 */
export async function processResponsesStream(events, output, stream, model) {
	let currentItem = null
	let currentBlock = null
	const blocks = output.content
	const blockIndex = () => blocks.length - 1

	for await (const event of events) {
		if (event.type === "response.created") {
			output.responseId = event.response?.id
			continue
		}

		if (event.type === "response.output_item.added") {
			const item = event.item
			if (item.type === "reasoning") {
				currentItem = item
				currentBlock = { type: "thinking", thinking: "" }
				blocks.push(currentBlock)
				stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output })
			} else if (item.type === "message") {
				currentItem = item
				currentBlock = { type: "text", text: "" }
				blocks.push(currentBlock)
				stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output })
			} else if (item.type === "function_call") {
				currentItem = item
				currentBlock = {
					type: "toolCall",
					id: `${item.call_id}|${item.id}`,
					name: item.name,
					arguments: {},
					partialJson: item.arguments || "",
				}
				blocks.push(currentBlock)
				stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output })
			}
			continue
		}

		if (event.type === "response.reasoning_summary_part.added") {
			if (currentItem?.type === "reasoning") {
				currentItem.summary = currentItem.summary || []
				currentItem.summary.push(event.part)
			}
			continue
		}

		if (event.type === "response.reasoning_summary_text.delta") {
			if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
				currentItem.summary = currentItem.summary || []
				const lastPart = currentItem.summary[currentItem.summary.length - 1]
				if (lastPart) {
					currentBlock.thinking += event.delta
					lastPart.text += event.delta
					stream.push({
						type: "thinking_delta",
						contentIndex: blockIndex(),
						delta: event.delta,
						partial: output,
					})
				}
			}
			continue
		}

		if (event.type === "response.reasoning_summary_part.done") {
			if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
				currentItem.summary = currentItem.summary || []
				const lastPart = currentItem.summary[currentItem.summary.length - 1]
				if (lastPart) {
					currentBlock.thinking += "\n\n"
					lastPart.text += "\n\n"
					stream.push({
						type: "thinking_delta",
						contentIndex: blockIndex(),
						delta: "\n\n",
						partial: output,
					})
				}
			}
			continue
		}

		if (event.type === "response.content_part.added") {
			if (currentItem?.type === "message") {
				currentItem.content = currentItem.content || []
				if (event.part.type === "output_text" || event.part.type === "refusal") {
					currentItem.content.push(event.part)
				}
			}
			continue
		}

		if (event.type === "response.output_text.delta") {
			if (currentItem?.type === "message" && currentBlock?.type === "text") {
				if (!currentItem.content || currentItem.content.length === 0) continue
				const lastPart = currentItem.content[currentItem.content.length - 1]
				if (lastPart?.type === "output_text") {
					currentBlock.text += event.delta
					lastPart.text += event.delta
					stream.push({
						type: "text_delta",
						contentIndex: blockIndex(),
						delta: event.delta,
						partial: output,
					})
				}
			}
			continue
		}

		if (event.type === "response.refusal.delta") {
			if (currentItem?.type === "message" && currentBlock?.type === "text") {
				if (!currentItem.content || currentItem.content.length === 0) continue
				const lastPart = currentItem.content[currentItem.content.length - 1]
				if (lastPart?.type === "refusal") {
					currentBlock.text += event.delta
					lastPart.refusal += event.delta
					stream.push({
						type: "text_delta",
						contentIndex: blockIndex(),
						delta: event.delta,
						partial: output,
					})
				}
			}
			continue
		}

		if (event.type === "response.function_call_arguments.delta") {
			if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall") {
				currentBlock.partialJson += event.delta
				currentBlock.arguments = parseStreamingJson(currentBlock.partialJson)
				stream.push({
					type: "toolcall_delta",
					contentIndex: blockIndex(),
					delta: event.delta,
					partial: output,
				})
			}
			continue
		}

		if (event.type === "response.function_call_arguments.done") {
			if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall") {
				const previous = currentBlock.partialJson
				currentBlock.partialJson = event.arguments
				currentBlock.arguments = parseStreamingJson(currentBlock.partialJson)
				if (event.arguments.startsWith(previous)) {
					const delta = event.arguments.slice(previous.length)
					if (delta.length > 0) {
						stream.push({
							type: "toolcall_delta",
							contentIndex: blockIndex(),
							delta,
							partial: output,
						})
					}
				}
			}
			continue
		}

		if (event.type === "response.output_item.done") {
			const item = event.item
			if (item.type === "reasoning" && currentBlock?.type === "thinking") {
				currentBlock.thinking = item.summary?.map((s) => s.text).join("\n\n") || ""
				currentBlock.thinkingSignature = JSON.stringify(item)
				stream.push({
					type: "thinking_end",
					contentIndex: blockIndex(),
					content: currentBlock.thinking,
					partial: output,
				})
				currentBlock = null
			} else if (item.type === "message" && currentBlock?.type === "text") {
				currentBlock.text =
					item.content?.map((c) => (c.type === "output_text" ? c.text : c.refusal)).join("") ?? ""
				currentBlock.textSignature = encodeTextSignature(item.id, item.phase ?? undefined)
				stream.push({
					type: "text_end",
					contentIndex: blockIndex(),
					content: currentBlock.text,
					partial: output,
				})
				currentBlock = null
			} else if (item.type === "function_call") {
				const args =
					currentBlock?.type === "toolCall" && currentBlock.partialJson
						? parseStreamingJson(currentBlock.partialJson)
						: parseStreamingJson(item.arguments || "{}")
				let toolCall
				if (currentBlock?.type === "toolCall") {
					currentBlock.arguments = args
					delete currentBlock.partialJson
					toolCall = currentBlock
				} else {
					toolCall = {
						type: "toolCall",
						id: `${item.call_id}|${item.id}`,
						name: item.name,
						arguments: args,
					}
				}
				currentBlock = null
				stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall, partial: output })
			}
			continue
		}

		if (event.type === "response.completed") {
			const response = event.response
			if (response?.id) output.responseId = response.id
			if (response?.usage) {
				const cached = response.usage.input_tokens_details?.cached_tokens || 0
				output.usage = {
					input: (response.usage.input_tokens || 0) - cached,
					output: response.usage.output_tokens || 0,
					cacheRead: cached,
					cacheWrite: 0,
					totalTokens: response.usage.total_tokens || 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				}
			}
			calculateCost(model, output.usage)
			output.stopReason = mapStopReason(response?.status)
			if (output.content.some((b) => b.type === "toolCall") && output.stopReason === "stop") {
				output.stopReason = "toolUse"
			}
			continue
		}

		if (event.type === "error") {
			throw new Error(`Error code ${event.code}: ${event.message ?? "(no message)"}`)
		}
		if (event.type === "response.failed") {
			const error = event.response?.error
			const details = event.response?.incomplete_details
			const msg = error
				? `${error.code || "unknown"}: ${error.message || "no message"}`
				: details?.reason
					? `incomplete: ${details.reason}`
					: "Unknown error"
			throw new Error(msg)
		}
	}
}
