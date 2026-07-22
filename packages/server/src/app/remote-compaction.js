// Explicit OpenAI Responses compaction, matching Codex CLI's remote-v2 shape.
//
// A dedicated request carries the ordinary model context followed by a
// `compaction_trigger` input item. The response must contain exactly one
// provider-native compaction item. We retain recent real user messages under
// a bounded budget, append the opaque checkpoint, and let the
// normal Pinano compaction persistence path install that replacement history.

import { stream as openaiStream } from "../ai-apis/index.js"
import { isResponsesCompactionBlock } from "../../../protocol/src/responses-compaction.js"
import { isFastModeEligibleModel } from "./fast-mode.js"
import { resolveModelStreamOptions } from "./model-auth.js"
import { modelCompactionHandoffMessage } from "./compaction-summary.js"
import { breakdownContext } from "./context/accounting.js"
import { prependEnvironmentContext } from "./environment-context.js"
import { isProjectContextMessage } from "./project-context.js"
import { buildModelMessagesForAgent } from "./session-context.js"

/** @typedef {import("../agent-core/agent.js").Agent} Agent */

export const REMOTE_COMPACTION_RETAINED_TOKEN_BUDGET = 64_000
const CHARS_PER_TOKEN = 4
const TRUNCATED_TOOL_OUTPUT = "Output exceeded the available model context and was truncated"

/** @param {any} model */
export function supportsRemoteCompaction(model) {
	return model?.provider === "openai-codex" && model?.compaction?.remoteResponses === true
}

/** @param {any} message */
function isGeneratedContextMessage(message) {
	return isProjectContextMessage(message) || message?.pinanoAutomated === true || message?.pinanoMaintenance === true
}

/** @param {any} message */
function isRetainableMessage(message) {
	return !isGeneratedContextMessage(message) && message?.role === "user"
}

/** Codex's remote-v2 retained-message budget counts text but not images. @param {any} message */
function messageTextTokens(message) {
	if (typeof message?.content === "string") return Math.ceil(message.content.length / CHARS_PER_TOKEN)
	if (!Array.isArray(message?.content)) return 0
	return message.content.reduce((total, block) =>
		total + (block?.type === "text" ? Math.ceil((block.text?.length ?? 0) / CHARS_PER_TOKEN) : 0), 0)
}

/** @param {string} value @param {number} maxTokens */
function truncateText(value, maxTokens) {
	if (maxTokens <= 0) return ""
	const maxChars = maxTokens * CHARS_PER_TOKEN
	if (value.length <= maxChars) return value
	const chars = [...value]
	const keptChars = Math.min(chars.length, maxChars)
	const headChars = Math.ceil(keptChars / 2)
	const tailChars = keptChars - headChars
	const removedTokens = Math.ceil(Math.max(0, value.length - maxChars) / CHARS_PER_TOKEN)
	return `${chars.slice(0, headChars).join("")}\n… ${removedTokens} token${removedTokens === 1 ? "" : "s"} truncated …\n${tailChars > 0 ? chars.slice(-tailChars).join("") : ""}`
}

/** Retain all images in a partially retained message, as Codex does. @param {any} message @param {number} maxTokens */
function truncateMessage(message, maxTokens) {
	if (typeof message.content === "string") {
		const content = truncateText(message.content, maxTokens)
		return content ? { ...message, content, pinanoRemoteCompactionRetained: true } : undefined
	}
	if (!Array.isArray(message.content)) return undefined
	let remaining = maxTokens
	const content = []
	for (const block of message.content) {
		if (block?.type === "image") {
			content.push(block)
			continue
		}
		if (block?.type !== "text" || remaining <= 0) continue
		const text = truncateText(block.text ?? "", remaining)
		if (!text) continue
		content.push({ ...block, text })
		remaining = Math.max(0, remaining - Math.ceil(text.length / CHARS_PER_TOKEN))
	}
	return content.length > 0 ? { ...message, content, pinanoRemoteCompactionRetained: true } : undefined
}

/**
 * Retain newest real user inputs under the same 64k approximate text-token
 * budget as Codex CLI. Output remains chronological.
 * @param {any[]} messages
 * @param {number} [maxTokens]
 */
export function selectRemoteCompactionRetainedMessages(messages, maxTokens = REMOTE_COMPACTION_RETAINED_TOKEN_BUDGET) {
	let remaining = Math.max(0, maxTokens)
	const retained = []
	for (const message of [...messages].reverse()) {
		if (remaining === 0 || !isRetainableMessage(message)) continue
		const tokens = Math.max(1, messageTextTokens(message))
		if (tokens <= remaining) {
			retained.push({ ...message, pinanoRemoteCompactionRetained: true })
			remaining -= tokens
			continue
		}
		const truncated = truncateMessage(message, remaining)
		if (truncated) retained.push(truncated)
		remaining = 0
	}
	return retained.reverse()
}

/** @param {Agent} agent @param {any[]} messages */
function buildRemoteCompactionMessages(agent, messages) {
	const modelMessages = agent.streamFn?.serviceMediated
		? messages.map(modelCompactionHandoffMessage)
		: buildModelMessagesForAgent(agent, messages)
	return agent.streamFn?.serviceMediated
		? modelMessages
		: prependEnvironmentContext(agent.pinanoEnvironmentContext?.(), modelMessages)
}

/** Mirror Codex's pre-compaction safeguard for a tool result that pushed the
 * active history over the context window. This projection affects only the
 * compaction request; durable history remains exact until a checkpoint is
 * successfully installed. @param {Agent} agent @param {any[]} messages */
function fitRemoteCompactionMessages(agent, messages) {
	const contextWindow = agent.state.model.contextWindow ?? 0
	if (!contextWindow) return messages
	const projected = [...messages]
	const breakdown = breakdownContext({
		messages: projected,
		systemPrompt: agent.state.systemPrompt,
		tools: agent.state.tools,
	})
	let estimatedTokens = breakdown.total
	for (let i = projected.length - 1; i >= 0 && estimatedTokens > contextWindow; i--) {
		const message = projected[i]
		if (message?.role !== "toolResult") continue
		const replacement = { ...message, content: [{ type: "text", text: TRUNCATED_TOOL_OUTPUT }] }
		projected[i] = replacement
		const replacementTokens = breakdownContext({ messages: [replacement] }).messagesTotal
		estimatedTokens -= Math.max(0, breakdown.perMessage[i].tokens - replacementTokens)
	}
	return projected
}

/** @param {Agent} agent @param {any[]} messages @param {AbortSignal} [signal] */
async function resolveModelInputAttachments(agent, messages, signal) {
	if (typeof agent.resolveModelInputAttachments !== "function") return messages
	return await agent.resolveModelInputAttachments(messages, signal)
}

/** @param {Agent} agent @param {any} context @param {AbortSignal} [signal] */
async function streamRemoteCompaction(agent, context, signal) {
	const model = agent.state.model
	const requestOptions = {
		signal,
		reasoning: agent.state.thinkingLevel,
		sessionId: agent.sessionId,
		serviceTier: isFastModeEligibleModel(model) ? agent.state.serviceTier : undefined,
		compactionTrigger: true,
	}
	if (agent.streamFn?.serviceMediated) return agent.streamFn(model, context, requestOptions)
	const streamOptions = await resolveModelStreamOptions(model, requestOptions)
	if (typeof agent.streamFn === "function") return agent.streamFn(model, context, streamOptions)
	return openaiStream(model, context, streamOptions)
}

/**
 * Ask the provider for one opaque checkpoint and construct Codex-style
 * replacement history. No agent or session state is mutated here.
 * @param {Agent} agent
 * @param {any[]} messages
 * @param {AbortSignal} [signal]
 */
export async function requestRemoteCompaction(agent, messages, signal) {
	const modelMessages = fitRemoteCompactionMessages(agent, buildRemoteCompactionMessages(agent, messages))
	const context = {
		systemPrompt: agent.state.systemPrompt,
		messages: await resolveModelInputAttachments(agent, modelMessages, signal),
		tools: agent.state.tools,
	}
	const stream = await streamRemoteCompaction(agent, context, signal)
	const final = await stream.result()
	if (final.errorMessage) throw new Error(final.errorMessage)
	const content = Array.isArray(final.content) ? final.content : []
	const compactionBlocks = content.filter(isResponsesCompactionBlock)
	if (compactionBlocks.length !== 1 || content.length !== 1) {
		throw new Error(`Remote compaction expected exactly one compaction output item, got ${compactionBlocks.length} from ${content.length} output items`)
	}
	const retainedMessages = selectRemoteCompactionRetainedMessages(messages)
	return {
		compactionBlock: compactionBlocks[0],
		retainedMessages,
		usage: final.usage,
	}
}
