// Conversation compaction.
//
// When the cumulative context approaches the model's contextWindow, we
// replace the oldest N messages with a compact checkpoint: selected recent
// user-message mementos plus a synthetic compaction summary marker. The
// summary is produced by asking the same model to summarize the discarded
// prefix.
//
// Strategy:
//   - threshold:   compact when usage > settings.autocompactThreshold * contextWindow
//   - cut point:   keep the last K turns intact; summarize everything before.
//                  The cut snaps forward across leading toolResults so that
//                  function_call/function_call_output pairs never split across
//                  the boundary (the OpenAI Responses API rejects an orphan
//                  function output).
//   - replacement: recent real user messages are retained as hidden model
//                  mementos, followed by a synthetic assistant handoff marker
//                  (`compaction: true`) that round-trips through agent context
//                  but is rendered specially.
//
// Persistence:
//   When the agent has a session and the cut boundary has an entry ID in
//   `agent.msgToEntryId`, the compaction is also written to session storage
//   as a `compaction` custom entry. On replay, Session.getLogicalEntries()
//   applies the entry as an agent-context patch, while getDisplayEntries()
//   keeps the original messages and inserts the marker at the cut boundary.
//   Without persistence, every resume would re-load the full pre-compaction
//   history into the agent and pay the re-compaction tax (or hit the "summary
//   prompt too big" cliff on very long sessions).

import { stream as openaiStream } from "../ai-apis/index.js"
import { compactionReplacementEntryId } from "../session-manager/session.js"
import {
	breakdownContext,
	estimateMessageTokens,
} from "./context-accounting.js"
import { resolveModelStreamOptions } from "./model-auth.js"
import { isFastModeEligibleModel } from "./fast-mode.js"
import { buildModelMessagesForAgent } from "./session-context.js"
import { isProjectContextMessage } from "./project-context.js"
import {
	COMPACTION_MARKER_PREFIX,
	SUMMARY_PROMPT,
	SUMMARY_USER_PREAMBLE,
	compactionSummaryText,
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
 * the real implementation lives in context-accounting.js.
 * @param {any[]} messages
 * @returns {number} */
export function estimateTokens(messages) {
	return estimateMessageTokens(messages)
}

/** Last reported usage from any prior assistant message, or 0.
 *
 * After a compaction, assistant messages kept in the tail still carry their
 * pre-compaction `totalTokens` — a number that reflects a prompt size that
 * no longer exists. We ignore those and fall back to the compaction marker's
 * own estimate until a fresh post-compaction turn reports real usage.
 * @param {any[]} messages
 * @returns {number} */
export function lastReportedTokens(messages) {
	let compactionTs = 0
	for (const m of messages) {
		if (m.compaction && m.timestamp) compactionTs = m.timestamp
	}
	let fallback = 0
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]
		if (m.compaction) {
			if (!fallback) fallback = m.usage?.totalTokens ?? 0
			continue
		}
		if (m.role !== "assistant") continue
		if (!m.usage?.totalTokens) continue
		if (compactionTs && (m.timestamp ?? 0) < compactionTs) continue
		return m.usage.totalTokens
	}
	return fallback
}

/** Decide whether the agent should compact before its next turn.
 *
 * `reported` is the last assistant turn's prompt_tokens (real, from the
 * provider) — stale by any toolResult or user message appended since.
 * `estimated` is a live estimate including the system prompt and tool
 * definitions (both are sent on every call but neither shows up in the
 * message walk). We take the max so a large tool result, a fat system
 * prompt, or many tool schemas still fire the threshold before the next
 * call.
 *
 * @param {Agent} agent
 * @param {number} threshold
 * @returns {boolean} */
export function shouldCompact(agent, threshold) {
	const ctx = agent.state.model.contextWindow ?? 0
	if (!ctx) return false
	const reported = lastReportedTokens(/** @type {any} */ (agent.state.messages))
	const messages = buildModelMessagesForAgent(agent, agent.state.messages)
	const estimated = breakdownContext({
		messages,
		systemPrompt: agent.state.systemPrompt,
		tools: agent.state.tools,
	}).total
	const used = Math.max(reported, estimated)
	return used >= threshold * ctx
}

/**
 * @param {Agent} agent
 * @param {any} ctx
 * @param {AbortSignal} [signal]
 * @returns {Promise<import("../ai-apis/event-stream.js").AssistantMessageEventStream>}
 */
async function streamForSummary(agent, ctx, signal) {
	const model = agent.state.model
	const options = {
		signal,
		serviceTier: isFastModeEligibleModel(model) ? agent.state.serviceTier : undefined,
		disableImplicitResponsesCompaction: true,
	}
	if (agent.streamFn?.serviceMediated) return agent.streamFn(model, ctx, options)
	const streamOptions = await resolveModelStreamOptions(model, options)
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
			if (block.type === "text") return block.text ?? ""
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

/** @param {any[]} prefix @param {any} compactionMsg @param {{ maxMementoTokens?: number }} [options] */
export function buildCompactionReplacementMessages(prefix, compactionMsg, options = {}) {
	return [...selectCompactionMementoMessages(prefix, options.maxMementoTokens), compactionMsg]
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
	if (message?.compaction === true) {
		const meta = [
			message.removedCount !== undefined ? `removed=${message.removedCount}` : "",
			message.keptCount !== undefined ? `kept=${message.keptCount}` : "",
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

/**
 * Run a non-streaming summarization using the same model with a custom system
 * prompt. Lightweight wrapper around the OpenAI Chat Completions stream — we
 * just collect the deltas.
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
	const ctx = {
		systemPrompt: options.systemPrompt ?? SUMMARY_PROMPT,
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: options.userPreamble ?? SUMMARY_USER_PREAMBLE },
					{ type: "text", text: serializeMessages(messages) },
				],
			},
		],
		tools: [],
	}
	const s = await streamForSummary(agent, ctx, options.signal)
	let buf = ""
	for await (const event of s) {
		if (event.type === "text_delta") buf += event.delta
	}
	const final = await s.result()
	if (final.errorMessage) throw new Error(final.errorMessage)
	if (!buf.trim()) {
		buf = (final.content ?? [])
			.filter((/** @type {any} */ c) => c.type === "text")
			.map((/** @type {any} */ c) => c.text)
			.join("\n")
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

/**
 * Compact the agent's transcript in place. Keeps the system prompt + the most
 * recent `keepLast` messages, replaces everything before with selected recent
 * user-message mementos plus a compaction-summary assistant marker.
 *
 * Returns metadata describing the compaction (used by /compact UI).
 *
 * @param {Agent} agent
 * @param {number} [keepLast]
 * @param {AbortSignal} [signal]
 * @returns {Promise<CompactionResult>}
 */
export async function compact(agent, keepLast = 6, signal) {
	const messages = /** @type {any[]} */ (agent.state.messages)
	const tokensBefore = lastReportedTokens(messages) || estimateTokens(messages)

	if (messages.length <= keepLast) {
		return { summary: "", keptCount: messages.length, removedCount: 0, tokensBefore }
	}
	const cutIndex = findCompactionCutIndex(messages, keepLast)
	const prefix = messages.slice(0, cutIndex)
	const tail = messages.slice(cutIndex)

	const { summary, usage: summaryUsage, summaryOmittedCount } = await summarize(agent, prefix, signal)
	// Carry the cost of the summarization API call so it shows up in the
	// running session total (the call is real money on metered providers).
	// Token counters stay at 0: the marker's `totalTokens` is reserved for
	// the post-compaction prompt-size estimate (see below). Metadata fields
	// (removedCount/keptCount/tokensBefore) are stamped on the marker too so
	// the renderer can show them in the compaction divider.
	const compactionMsg = {
		role: "assistant",
		content: [{ type: "text", text: `${COMPACTION_MARKER_PREFIX}\n${summary}` }],
		provider: agent.state.model.provider,
		model: agent.state.model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: {
				input: summaryUsage?.cost?.input ?? 0,
				output: summaryUsage?.cost?.output ?? 0,
				cacheRead: summaryUsage?.cost?.cacheRead ?? 0,
				cacheWrite: summaryUsage?.cost?.cacheWrite ?? 0,
				total: summaryUsage?.cost?.total ?? 0,
			},
		},
		stopReason: "stop",
		timestamp: Date.now(),
		compaction: true,
		removedCount: prefix.length,
		keptCount: tail.length,
		tokensBefore,
		summaryOmittedCount,
	}
	const basePostCompactTokens = breakdownContext({
		messages: buildModelMessagesForAgent(agent, [compactionMsg, ...tail]),
		systemPrompt: agent.state.systemPrompt,
		tools: agent.state.tools,
	}).total
	const replacementMessages = buildCompactionReplacementMessages(prefix, compactionMsg, {
		maxMementoTokens: compactionMementoBudget(agent, basePostCompactTokens),
	})
	const newMessages = [...replacementMessages, ...tail]
	// Stamp the new prompt size estimate so the footer and shouldCompact
	// can stop showing the stale pre-compaction percentage. Includes the
	// system prompt and tool definitions — both are sent on every request
	// and form a non-trivial slice of the token budget. Kept tail
	// assistants still carry their old totalTokens; consumers ignore
	// those once they see this marker (see lastReportedTokens /
	// Footer.update).
	compactionMsg.usage.totalTokens = breakdownContext({
		messages: buildModelMessagesForAgent(agent, newMessages),
		systemPrompt: agent.state.systemPrompt,
		tools: agent.state.tools,
	}).total

	agent.state.messages = /** @type {any} */ (newMessages)

	// Persist the compaction as a custom session entry so its agent-context
	// effect survives resume. Without this, `session.getMessages()` on the
	// next resume would return the full pre-compaction history to the model
	// and pay the re-compaction tax (or hit the "summary prompt too big"
	// cliff) on every reload. Schema is read by Session.getLogicalEntries()
	// and Session.getDisplayEntries(): `cutEntryId` is the upper bound of
	// the compacted range; `replacementContext` is the model-facing patch;
	// `message`/`displayMessage` are the visible synthetic marker.
	//
	// We need a `cutEntryId` — the storage entry that produced the last
	// elided in-memory message. Interactive/RPC frontends maintain the
	// Message→EntryId map; we look up the boundary in it. If the map is
	// missing (no frontend, or the boundary is an in-memory-only message
	// like an unpersisted steering prompt), we skip the persist step
	// gracefully — compaction still works in-memory, just won't survive
	// resume for this particular event. That preserves today's behavior
	// in code paths that don't wire up the map.
	const boundary = prefix[prefix.length - 1]
	if (agent.persistCompaction) {
		try {
			const newEntryId = await agent.persistCompaction({
				version: 2,
				cutMessageIndex: prefix.length - 1,
				message: compactionMsg,
				displayMessage: compactionMsg,
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
					message: compactionMsg,
					displayMessage: compactionMsg,
					replacementContext: { kind: "pinano-messages", messages: replacementMessages },
				})
				// Map the synthetic replacement messages to persisted IDs so any
				// further compaction whose boundary lands on this checkpoint can
				// resolve its `cutEntryId` (the nested-compaction case).
				mapReplacementEntryIds(agent, newEntryId, replacementMessages)
			} catch (err) {
				// Surface but don't fail compaction — in-memory state is
				// already correct, we just lost durability for this event.
				console.error("compaction persist failed:", err instanceof Error ? err.message : err)
			}
		}
	}

	// Notify subscribers (live UIs render the marker into the transcript so
	// the user sees that compaction happened). Optional-chain
	// to tolerate unit-test stubs that don't implement the method.
	await agent.notifyCompaction?.(compactionMsg)

	return {
		summary,
		keptCount: tail.length,
		removedCount: prefix.length,
		tokensBefore,
		mementoCount: replacementMessages.length - 1,
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
		|| messages[cut]?.compaction === true
	)) {
		cut++
	}
	return cut
}
