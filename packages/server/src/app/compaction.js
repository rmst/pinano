// Conversation compaction.
//
// When the cumulative context approaches the model's contextWindow, we
// replace the current logical history with a compact checkpoint. Official
// ChatGPT/Codex models use explicit Responses remote-v2 compaction; other
// models use a local handoff summary produced by the same model.
//
// Strategy:
//   - threshold:   compact when usage reaches the internal threshold fraction
//                  of the model context window
//   - remote:      retain bounded real user inputs, then append the
//                  opaque provider checkpoint exactly as returned
//   - local:       retain recent user-message mementos, then append a user-role
//                  handoff summary (`pinanoCompactionSummary: true`)
//   - display:     a separate `compaction: true` marker is emitted/persisted
//
// Persistence:
//   When the agent has a session and the last replaced message has an entry ID
//   in `agent.msgToEntryId`, the compaction is also written to session storage
//   as a `compaction` custom entry. On replay, Session.getLogicalEntries()
//   applies the entry as an agent-context patch, while getDisplayEntries()
//   keeps the original messages and inserts the marker at the cut boundary.
//   Without persistence, every resume would re-load the full pre-compaction
//   history into the agent and pay the re-compaction tax (or hit the "summary
//   prompt too big" cliff on very long sessions).

import { stream as openaiStream } from "../ai-apis/index.js"
import { messageHasResponsesCompactionItem } from "../../../protocol/src/responses-compaction.js"
import { isPromptImageMarkerText } from "../../../protocol/src/prompt-images.js"
import { compactionReplacementEntryId } from "../session-manager/session.js"
import {
	breakdownContext,
	estimateMessageTokens,
} from "./context/accounting.js"
import { resolveModelStreamOptions } from "./model-auth.js"
import { isFastModeEligibleModel } from "./fast-mode.js"
import { buildModelMessagesForAgent } from "./session-context.js"
import { prependEnvironmentContext } from "./environment-context.js"
import { isProjectContextMessage } from "./project-context.js"
import { requestRemoteCompaction, supportsRemoteCompaction } from "./remote-compaction.js"
import { estimateContextUse, lastReportedTokens } from "./context/summary.js"
import {
	SUMMARY_PROMPT,
	SUMMARY_USER_PREAMBLE,
	compactionSummaryText,
	isCompactionCheckpointMessage,
	isCompactionSummaryMessage,
	modelCompactionHandoffMessage,
} from "./compaction-summary.js"

/** @typedef {import("../agent-core/agent.js").Agent} Agent */

/**
 * @typedef {object} CompactionResult
 * @property {string} summary
 * @property {number} keptCount
 * @property {number} removedCount
 * @property {number} tokensBefore
 * @property {number} [mementoCount]
 * @property {number} [summaryOmittedCount]
 */

/** Approximate token count of the messages alone. Re-exported for back-compat;
 * the real implementation lives in context/accounting.js.
 * @param {any[]} messages
 * @returns {number} */
export function estimateTokens(messages) {
	return estimateMessageTokens(messages)
}

export { lastReportedTokens }

/** Decide whether the agent should compact before its next turn.
 *
 * The provider-reported baseline is authoritative for the already-counted
 * prefix. Local accounting estimates only the messages appended since that
 * baseline, with the full local estimate kept as a fallback/sanity check.
 *
 * @param {Agent} agent
 * @param {number} threshold
 * @returns {boolean} */
export function shouldCompact(agent, threshold) {
	const ctx = agent.state.model.contextWindow ?? 0
	if (!ctx) return false
	const messages = buildModelMessagesForAgent(agent, agent.state.messages)
	const usage = estimateContextUse({
		messages,
		systemPrompt: agent.state.systemPrompt,
		tools: agent.state.tools,
	})
	return usage.usedTokens >= threshold * ctx
}

/**
 * @param {Agent} agent
 * @param {any} ctx
 * @param {import("../ai-apis/types.js").StreamOptions} [options]
 * @returns {Promise<import("../ai-apis/event-stream.js").AssistantMessageEventStream>}
 */
async function streamForSummary(agent, ctx, options = {}) {
	const model = agent.state.model
	const requestOptions = {
		...options,
		reasoning: options.reasoning ?? agent.state.thinkingLevel,
		sessionId: options.sessionId ?? agent.sessionId,
		serviceTier: isFastModeEligibleModel(model) ? agent.state.serviceTier : undefined,
	}
	if (agent.streamFn?.serviceMediated) return agent.streamFn(model, ctx, requestOptions)
	const streamOptions = await resolveModelStreamOptions(model, requestOptions)
	if (typeof agent.streamFn === "function") return agent.streamFn(model, ctx, streamOptions)
	return openaiStream(model, ctx, streamOptions)
}

/** Render a list of messages as a plaintext transcript for the summarizer.
 * @param {any[]} messages
 * @returns {string} */
function serializeMessages(messages) {
	return messages.map(serializeMessage).join("\n\n")
}

const SUMMARY_TEXT_MAX_CHARS = 12000
const TOOL_ARGUMENTS_MAX_CHARS = 4000
const TOOL_RESULT_MAX_CHARS = 4000
const CONTEXT_LIMIT_ERROR_RE = /context\s*(window|length)?\s*exceeded|maximum\s*context|too\s*many\s*tokens|token\s*limit|exceeds?\s+.*tokens|input\s+too\s+large|request\s+too\s+large/i

export const COMPACTION_MEMENTO_MAX_TOKENS = 20_000
const COMPACTION_TARGET_CONTEXT_FRACTION = 0.8

/**
 * @param {string} text
 * @param {number} maxChars
 */
function truncateForSummary(text, maxChars) {
	if (text.length <= maxChars) return text
	const omitted = text.length - maxChars
	const headChars = Math.floor(maxChars * 0.65)
	const tailChars = maxChars - headChars
	return `${text.slice(0, headChars)}\n… [truncated ${omitted} char${omitted === 1 ? "" : "s"}] …\n${text.slice(-tailChars)}`
}

/** @param {any} value */
function jsonForSummary(value) {
	try {
		return JSON.stringify(value, null, "\t")
	} catch {
		return String(value)
	}
}

/** @param {any} content */
function textFromContent(content) {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return content
		.map((/** @type {any} */ block) => {
			if (block.type === "text") return isPromptImageMarkerText(block.text ?? "") ? "" : block.text ?? ""
			if (block.type === "image") return `[image${block.mediaType ? ` ${block.mediaType}` : ""}]`
			return ""
		})
		.filter(Boolean)
		.join("\n")
}

/** @param {string} text */
function estimateUserTextTokens(text) {
	return estimateTokens([{ role: "user", content: text }])
}

/** @param {string} text @param {number} maxChars */
function truncateForMemento(text, maxChars) {
	if (text.length <= maxChars) return text
	if (maxChars <= 0) return ""
	const omitted = text.length - maxChars
	const marker = `\n… [truncated ${omitted} char${omitted === 1 ? "" : "s"} for compaction memento] …\n`
	if (maxChars <= marker.length + 2) return text.slice(0, maxChars)
	const keptChars = maxChars - marker.length
	const headChars = Math.ceil(keptChars * 0.65)
	const tailChars = keptChars - headChars
	const head = text.slice(0, headChars)
	return tailChars > 0 ? `${head}${marker}${text.slice(-tailChars)}` : `${head}${marker}`
}

/** @param {string} text @param {number} maxTokens */
function truncateTextToTokenBudget(text, maxTokens) {
	if (maxTokens <= 0) return ""
	if (estimateUserTextTokens(text) <= maxTokens) return text
	let lo = 1
	let hi = Math.max(1, text.length)
	let best = ""
	while (lo <= hi) {
		const mid = Math.floor((lo + hi) / 2)
		const candidate = truncateForMemento(text, mid)
		if (candidate && estimateUserTextTokens(candidate) <= maxTokens) {
			best = candidate
			lo = mid + 1
		} else {
			hi = mid - 1
		}
	}
	return best
}

/** @param {any} message */
function isRealUserMessageForMemento(message) {
	return message?.role === "user"
		&& !message.pinanoAutomated
		&& !message.pinanoMaintenance
		&& !message.branchSummary
		&& !isCompactionSummaryMessage(message)
		&& !isProjectContextMessage(message)
}

/** @param {string} text */
function compactionMementoMessage(text) {
	return {
		role: "user",
		content: text,
		pinanoCompactionMemento: true,
	}
}

/**
 * Retain recent real user intent verbatim inside the compacted model context.
 * Summaries preserve facts; mementos preserve the user's own wording for the
 * most recent goals and constraints that would otherwise be hidden behind the
 * summary marker.
 * @param {any[]} messages
 * @param {number} [maxTokens]
 * @returns {any[]}
 */
export function selectCompactionMementoMessages(messages, maxTokens = COMPACTION_MEMENTO_MAX_TOKENS) {
	const selected = []
	let remaining = Math.max(0, maxTokens)
	for (const message of [...messages].reverse()) {
		if (remaining <= 0) break
		if (!isRealUserMessageForMemento(message)) continue
		const text = textFromContent(message.content).trim()
		if (!text) continue
		const tokens = estimateUserTextTokens(text)
		if (tokens <= remaining) {
			selected.push(compactionMementoMessage(text))
			remaining -= tokens
			continue
		}
		const truncated = truncateTextToTokenBudget(text, remaining).trim()
		if (truncated) selected.push(compactionMementoMessage(truncated))
		break
	}
	return selected.reverse()
}

/** @param {any[]} messages @param {any} summaryMessage @param {{ maxMementoTokens?: number }} [options] */
export function buildCompactionReplacementMessages(messages, summaryMessage, options = {}) {
	return [...selectCompactionMementoMessages(messages, options.maxMementoTokens), summaryMessage]
}

/** @param {any} message */
function toolCallsFromMessage(message) {
	const content = Array.isArray(message.content) ? message.content : []
	return content.filter((/** @type {any} */ block) => block.type === "toolCall")
}

/** @param {any} value */
function attr(value) {
	return String(value ?? "").replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;")
}

/** @param {any} call */
function serializeToolCall(call) {
	const args = call.arguments === undefined ? "" : `\narguments: ${truncateForSummary(jsonForSummary(call.arguments), TOOL_ARGUMENTS_MAX_CHARS)}`
	return `<tool_call name="${attr(call.name ?? "unknown")}" id="${attr(call.id ?? "")}">${args}\n</tool_call>`
}

/** @param {any} message */
function serializeMessage(message) {
	if (isCompactionCheckpointMessage(message)) {
		const meta = [
			message.removedCount !== undefined ? `removed=${message.removedCount}` : "",
			message.mementoCount !== undefined ? `mementos=${message.mementoCount}` : "",
			message.mementoCount !== undefined && message.keptCount ? `provider_checkpoints=${message.keptCount}` : "",
			message.mementoCount === undefined && message.keptCount !== undefined ? `kept=${message.keptCount}` : "",
		].filter(Boolean).join(" ")
		return `<compaction_summary${meta ? ` ${meta}` : ""}>\n${truncateForSummary(compactionSummaryText(message), SUMMARY_TEXT_MAX_CHARS)}\n</compaction_summary>`
	}

	const role = message?.role ?? "unknown"
	const text = textFromContent(message?.content).trim()
	const toolCalls = toolCallsFromMessage(message)
	if (role === "assistant" && toolCalls.length > 0) {
		return [
			`<message role="assistant">`,
			text,
			...toolCalls.map(serializeToolCall),
			`</message>`,
		].filter(Boolean).join("\n")
	}
	if (role === "toolResult") {
		const attrs = [
			`name="${attr(message.toolName ?? "unknown")}"`,
			message.toolCallId ? `call_id="${attr(message.toolCallId)}"` : "",
			message.isError ? `status="error"` : `status="ok"`,
		].filter(Boolean).join(" ")
		return `<tool_result ${attrs}>\n${truncateForSummary(text, TOOL_RESULT_MAX_CHARS)}\n</tool_result>`
	}
	return `<message role="${attr(role)}">\n${truncateForSummary(text, SUMMARY_TEXT_MAX_CHARS)}\n</message>`
}

/** @param {any} message */
function isGeneratedContextMessage(message) {
	return isProjectContextMessage(message) || message?.pinanoAutomated === true || message?.pinanoMaintenance === true
}

/** @param {any[]} messages */
function compactableMessages(messages) {
	return messages.filter((message) => !isGeneratedContextMessage(message))
}

/** @param {any[]} messages */
function latestResponsesCompactionIndex(messages) {
	let latest = -1
	for (let i = 0; i < messages.length; i++) {
		if (messageHasResponsesCompactionItem(messages[i])) latest = i
	}
	return latest
}

/** @param {any[]} messages */
function compactionSource(messages) {
	const sourceMessages = compactableMessages(messages)
	const nativeIndex = latestResponsesCompactionIndex(sourceMessages)
	if (nativeIndex < 0) return { preservedMessages: [], summarySourceMessages: sourceMessages }
	return {
		preservedMessages: [sourceMessages[nativeIndex]],
		summarySourceMessages: sourceMessages.slice(nativeIndex + 1),
	}
}

/** @param {Agent} agent @param {any[]} messages */
function buildSummaryMessages(agent, messages) {
	const modelMessages = agent.streamFn?.serviceMediated
		? messages.map(modelCompactionHandoffMessage)
		: buildModelMessagesForAgent(agent, messages)
	return agent.streamFn?.serviceMediated
		? modelMessages
		: prependEnvironmentContext(agent.pinanoEnvironmentContext?.(), modelMessages)
}

/** @param {Agent} agent @param {any[]} messages @param {AbortSignal} [signal] */
async function resolveModelInputAttachments(agent, messages, signal) {
	if (typeof agent.resolveModelInputAttachments !== "function") return messages
	return await agent.resolveModelInputAttachments(messages, signal)
}

/** @param {any[]} messages @param {string} prompt */
function appendSummaryPrompt(messages, prompt) {
	return [
		...messages,
		{
			role: "user",
			content: prompt,
			pinanoMaintenance: true,
		},
	]
}

/** @param {any} final */
function textFromSummaryFinalMessage(final) {
	return (final.content ?? [])
		.filter((/** @type {any} */ c) => c.type === "text")
		.map((/** @type {any} */ c) => c.text)
		.join("\n")
}

/** @param {any} final */
function assertSummaryWasText(final) {
	const toolCalls = (final.content ?? []).filter((/** @type {any} */ c) => c.type === "toolCall")
	if (toolCalls.length > 0) {
		const names = toolCalls.map((/** @type {any} */ c) => c.name || "unknown").join(", ")
		throw new Error(`Compaction summary produced tool call${toolCalls.length === 1 ? "" : "s"} instead of text: ${names}`)
	}
}

/**
 * Run a non-streaming summarization using the same model. Default compaction
 * preserves the normal model-facing prompt prefix and appends the compact
 * instruction as the final user message. Custom summary prompts keep the
 * older serialized-transcript shape used by branch summaries.
 *
 * Returns the summary text together with the usage object from the underlying
 * call so callers can bill the cost back to the agent's running total.
 *
 * @param {Agent} agent
 * @param {any[]} messages
 * @param {{ systemPrompt?: string, userPreamble?: string, signal?: AbortSignal }} [options]
 * @returns {Promise<{ summary: string, usage: any }>}
 */
export async function summarizeMessages(agent, messages, options = {}) {
	const customPrompt = options.systemPrompt !== undefined || options.userPreamble !== undefined
	const summaryMessages = customPrompt
		? [
			{
				role: "user",
				content: [
					{ type: "text", text: options.userPreamble ?? SUMMARY_USER_PREAMBLE },
					{ type: "text", text: serializeMessages(messages) },
				],
			},
		]
		: appendSummaryPrompt(buildSummaryMessages(agent, messages), SUMMARY_PROMPT)
	const ctx = {
		systemPrompt: customPrompt ? options.systemPrompt ?? SUMMARY_PROMPT : agent.state.systemPrompt,
		messages: await resolveModelInputAttachments(agent, summaryMessages, options.signal),
		tools: [],
	}
	const s = await streamForSummary(agent, ctx, { signal: options.signal })
	let buf = ""
	for await (const event of s) {
		if (event.type === "text_delta") buf += event.delta
	}
	const final = await s.result()
	if (final.errorMessage) throw new Error(final.errorMessage)
	assertSummaryWasText(final)
	if (!buf.trim()) {
		buf = textFromSummaryFinalMessage(final)
	}
	return { summary: buf.trim(), usage: final.usage }
}

/** @param {unknown} err */
function errorSearchText(err) {
	const value = /** @type {any} */ (err)
	return [
		value?.message,
		value?.error?.message,
		value?.code,
		value?.type,
		value?.status,
		String(err ?? ""),
	].filter(Boolean).join("\n")
}

/** @param {unknown} err */
export function isContextLimitError(err) {
	return CONTEXT_LIMIT_ERROR_RE.test(errorSearchText(err))
}

/** @param {string} summary @param {number} omittedCount */
function withSummaryOmissionNote(summary, omittedCount) {
	if (!omittedCount) return summary
	const note = `${omittedCount} oldest compacted message${omittedCount === 1 ? " was" : "s were"} omitted from the summarization request because it exceeded the model context window.`
	return summary ? `${note}\n\n${summary}` : note
}

/** Backward-compat default summarizer — used by /compact.
 * @param {Agent} agent
 * @param {any[]} prefix
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ summary: string, usage: any, summarizedCount: number, summaryOmittedCount: number }>} */
async function summarize(agent, prefix, signal) {
	let candidate = prefix
	let summaryOmittedCount = 0
	for (;;) {
		try {
			const result = await summarizeMessages(agent, candidate, { signal })
			return {
				...result,
				summary: withSummaryOmissionNote(result.summary, summaryOmittedCount),
				summarizedCount: candidate.length,
				summaryOmittedCount,
			}
		} catch (err) {
			if (!isContextLimitError(err) || candidate.length === 0) throw err
			const dropCount = candidate.length === 1 ? 1 : Math.max(1, Math.ceil(candidate.length * 0.1))
			candidate = candidate.slice(dropCount)
			summaryOmittedCount += dropCount
		}
	}
}

/** @param {Agent} agent @param {string | undefined} entryId @param {any[]} replacementMessages */
function mapReplacementEntryIds(agent, entryId, replacementMessages) {
	if (!entryId || !agent.msgToEntryId) return
	replacementMessages.forEach((message, i) => {
		agent.msgToEntryId.set(message, compactionReplacementEntryId(entryId, replacementMessages, i))
	})
}

/** @param {Agent} agent @param {number} basePostCompactTokens */
function compactionMementoBudget(agent, basePostCompactTokens) {
	const contextWindow = agent.state.model.contextWindow ?? 0
	if (!contextWindow) return COMPACTION_MEMENTO_MAX_TOKENS
	const targetTokens = Math.floor(contextWindow * COMPACTION_TARGET_CONTEXT_FRACTION)
	return Math.min(COMPACTION_MEMENTO_MAX_TOKENS, Math.max(0, targetTokens - basePostCompactTokens))
}

/** @param {any} usage */
function compactionCheckpointUsage(usage) {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: {
			input: usage?.cost?.input ?? 0,
			output: usage?.cost?.output ?? 0,
			cacheRead: usage?.cost?.cacheRead ?? 0,
			cacheWrite: usage?.cost?.cacheWrite ?? 0,
			total: usage?.cost?.total ?? 0,
		},
	}
}

/** @param {any} usage */
function cloneUsage(usage) {
	return { ...usage, cost: { ...usage.cost } }
}

/**
 * Install and persist a generated replacement through the one durable
 * compaction lifecycle shared by local summaries and provider checkpoints.
 * @param {Agent} agent
 * @param {any[]} previousMessages
 * @param {any[]} replacementMessages
 * @param {any} checkpointMessage
 * @param {any} displayMessage
 */
async function installCompaction(agent, previousMessages, replacementMessages, checkpointMessage, displayMessage) {
	const postCompactTokens = breakdownContext({
		messages: buildModelMessagesForAgent(agent, replacementMessages),
		systemPrompt: agent.state.systemPrompt,
		tools: agent.state.tools,
	}).total
	displayMessage.usage.totalTokens = postCompactTokens
	checkpointMessage.usage.totalTokens = postCompactTokens
	agent.state.messages = /** @type {any} */ (replacementMessages)

	const boundary = previousMessages[previousMessages.length - 1]
	if (agent.persistCompaction) {
		try {
			const newEntryId = await agent.persistCompaction({
				version: 2,
				cutMessageIndex: previousMessages.length - 1,
				displayMessage,
				replacementContext: { kind: "pinano-messages", messages: replacementMessages },
			})
			mapReplacementEntryIds(agent, newEntryId, replacementMessages)
		} catch (err) {
			console.error("compaction persist failed:", err instanceof Error ? err.message : err)
		}
	} else {
		const cutEntryId = boundary ? agent.msgToEntryId?.get(boundary) : undefined
		if (agent.session && cutEntryId) {
			try {
				const newEntryId = await agent.session.appendCustomEntry("compaction", {
					version: 2,
					cutEntryId,
					displayMessage,
					replacementContext: { kind: "pinano-messages", messages: replacementMessages },
				})
				mapReplacementEntryIds(agent, newEntryId, replacementMessages)
			} catch (err) {
				console.error("compaction persist failed:", err instanceof Error ? err.message : err)
			}
		}
	}

	await agent.notifyCompaction?.(displayMessage)
}

/** @param {Agent} agent @param {any[]} messages @param {number} tokensBefore @param {AbortSignal} [signal] */
async function compactRemote(agent, messages, tokensBefore, signal) {
	const remote = await requestRemoteCompaction(agent, messages, signal)
	const usage = compactionCheckpointUsage(remote.usage)
	const meta = {
		provider: agent.state.model.provider,
		model: agent.state.model.id,
		stopReason: "stop",
		timestamp: Date.now(),
		removedCount: messages.length,
		keptCount: remote.retainedMessages.length,
		tokensBefore,
	}
	const checkpointMessage = {
		role: "assistant",
		content: [remote.compactionBlock],
		...meta,
		usage: cloneUsage(usage),
		pinanoRemoteCompaction: true,
	}
	const displayMessage = {
		role: "assistant",
		content: [{ type: "text", text: "Opaque checkpoint generated by the model provider." }],
		...meta,
		usage: cloneUsage(usage),
		compaction: true,
		remoteCompaction: true,
	}
	const replacementMessages = [...remote.retainedMessages, checkpointMessage]
	await installCompaction(agent, messages, replacementMessages, checkpointMessage, displayMessage)
	return {
		summary: "",
		keptCount: remote.retainedMessages.length,
		removedCount: messages.length,
		tokensBefore,
	}
}

/**
 * Compact the agent's transcript in place. Supported Codex models install an
 * opaque provider checkpoint plus bounded real user inputs; other models
 * install retained user mementos plus a local handoff summary. The user-facing
 * transcript always gets a separate assistant divider marker.
 *
 * Returns metadata describing the compaction (used by /compact UI).
 *
 * @param {Agent} agent
 * @param {number} [keepLast] Legacy compatibility parameter; whole-history compaction ignores it.
 * @param {AbortSignal} [signal]
 * @returns {Promise<CompactionResult>}
 */
export async function compact(agent, keepLast = 6, signal) {
	void keepLast
	const messages = /** @type {any[]} */ (agent.state.messages)
	const tokensBefore = lastReportedTokens(messages) || estimateTokens(messages)

	if (messages.length === 0) {
		return { summary: "", keptCount: 0, removedCount: 0, tokensBefore }
	}
	const { preservedMessages, summarySourceMessages } = compactionSource(messages)
	if (summarySourceMessages.length === 0) {
		return { summary: "", keptCount: preservedMessages.length, removedCount: 0, tokensBefore, mementoCount: 0 }
	}
	if (supportsRemoteCompaction(agent.state.model)) {
		try {
			return await compactRemote(agent, messages, tokensBefore, signal)
		} catch (err) {
			if (signal?.aborted) throw err
			console.error("remote compaction failed; falling back to local compaction:", err instanceof Error ? err.message : err)
		}
	}

	const { summary, usage: summaryUsage, summaryOmittedCount } = await summarize(agent, summarySourceMessages, signal)
	// Carry the cost of the summarization API call so it shows up in the
	// running session total (the call is real money on metered providers).
	// Token counters stay at 0: `totalTokens` is reserved for the
	// post-compaction prompt-size estimate (see below). Metadata fields are
	// stamped on both the visible marker and the model-facing summary.
	const compactionUsage = compactionCheckpointUsage(summaryUsage)
	const compactionMeta = {
		provider: agent.state.model.provider,
		model: agent.state.model.id,
		usage: compactionUsage,
		stopReason: "stop",
		timestamp: Date.now(),
		removedCount: messages.length - preservedMessages.length,
		keptCount: preservedMessages.length,
		tokensBefore,
		summaryOmittedCount,
	}
	const displayMessage = {
		role: "assistant",
		content: [{ type: "text", text: summary }],
		...compactionMeta,
		usage: cloneUsage(compactionUsage),
		compaction: true,
	}
	const summaryMessage = modelCompactionHandoffMessage(displayMessage)
	const basePostCompactTokens = breakdownContext({
		messages: buildModelMessagesForAgent(agent, [...preservedMessages, summaryMessage]),
		systemPrompt: agent.state.systemPrompt,
		tools: agent.state.tools,
	}).total
	const replacementMessages = [
		...preservedMessages,
		...buildCompactionReplacementMessages(summarySourceMessages, summaryMessage, {
			maxMementoTokens: compactionMementoBudget(agent, basePostCompactTokens),
		}),
	]
	const mementoCount = replacementMessages.length - preservedMessages.length - 1
	displayMessage.mementoCount = mementoCount
	summaryMessage.mementoCount = mementoCount
	await installCompaction(agent, messages, replacementMessages, summaryMessage, displayMessage)

	return {
		summary,
		keptCount: preservedMessages.length,
		removedCount: messages.length - preservedMessages.length,
		tokensBefore,
		mementoCount,
		summaryOmittedCount,
	}
}

/** Find a safe cut index that won't orphan a tool result.
 *
 * A blind `messages.length - keepLast` cut can land between an assistant's
 * `toolCall` and its `toolResult`. The call ends up summarized away (its
 * `call_id` is gone) and the orphaned result triggers a provider error
 * (e.g. OpenAI Responses: "No tool call found for function call output
 * with call_id …"). It can also split a previous compaction checkpoint's
 * hidden mementos from its marker. Walk the cut forward so leading toolResults
 * and partial checkpoint fragments get absorbed into the summarized prefix.
 *
 * @param {any[]} messages
 * @param {number} keepLast
 * @returns {number} */
export function findCompactionCutIndex(messages, keepLast) {
	let cut = messages.length - keepLast
	if (cut < 0) cut = 0
	while (cut < messages.length && (
		messages[cut]?.role === "toolResult"
		|| messages[cut]?.pinanoCompactionMemento
		|| isCompactionCheckpointMessage(messages[cut])
	)) {
		cut++
	}
	return cut
}
