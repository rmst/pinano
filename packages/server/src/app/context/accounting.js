// Single source of truth for "how much of the model's context window is
// being used right now". Replaces the message-only `estimateTokens` in
// compaction.js — that function ignored the system prompt and the tool
// schemas, both of which can easily run into thousands of tokens and push
// us past the auto-compact threshold before the message walk reflects it.
//
// All consumers (shouldCompact, the footer, the new /context command,
// and compact()'s post-compaction marker) read from `breakdownContext`
// so the numbers can't drift between them.
//
// Token counting is a 4-chars-per-token heuristic. That's crude but
// matches what the rest of the codebase already used, and a real
// tokenizer would bloat the binary considerably. Be transparent about
// it in /context output.

import { isCompactionCheckpointMessage, isCompactionSummaryMessage } from "../compaction-summary.js"
import { isProjectContextMessage } from "../project-context-message.js"

const CHARS_PER_TOKEN = 4
const MESSAGE_OVERHEAD = 8
const TOOLCALL_OVERHEAD = 8
// Per-image flat estimate. Matches pi (`packages/agent/src/harness/compaction
// /compaction.ts`): 4800 chars ÷ 4 ≈ 1200 tok. Real image tokenization is
// resolution-dependent (Anthropic: ~1.6k for low, ~5k+ for high; OpenAI:
// 85 + 170 per 512×512 tile) so this is a defensible single-number proxy.
const IMAGE_TOKENS = 1200

/**
 * @param {string | undefined | null} s
 * @returns {number}
 */
function tokenize(s) {
	if (!s) return 0
	return Math.ceil(s.length / CHARS_PER_TOKEN)
}

/**
 * Token cost of a single tool definition's JSON schema. Producers stringify
 * the schema before sending; this approximates that.
 *
 * @param {any} tool
 * @returns {number}
 */
export function toolTokens(tool) {
	if (!tool) return 0
	try {
		const json = JSON.stringify(tool.kind === "custom"
			? { name: tool.name, description: tool.description, format: tool.format }
			: { name: tool.name, description: tool.description, parameters: tool.parameters })
		return tokenize(json) + TOOLCALL_OVERHEAD
	} catch {
		return tokenize(String(tool?.name ?? "")) + TOOLCALL_OVERHEAD
	}
}

/**
 * Token cost of one logical message (user / assistant / toolResult / synthetic).
 *
 * @param {any} m
 * @returns {{ tokens: number, breakdown: { text: number, thinking: number, toolCall: number, image: number } }}
 */
function messageTokens(m) {
	const breakdown = { text: 0, thinking: 0, toolCall: 0, image: 0 }
	if (typeof m.content === "string") {
		breakdown.text += tokenize(m.content)
	} else if (Array.isArray(m.content)) {
		for (const c of m.content) {
			if (c?.type === "text") breakdown.text += tokenize(c.text)
			else if (c?.type === "thinking") breakdown.thinking += tokenize(c.thinking)
			else if (c?.type === "image") breakdown.image += IMAGE_TOKENS
			else if (c?.type === "toolCall") {
				let argLen = 0
				try {
					argLen = typeof c.input === "string" ? tokenize(c.input) : tokenize(JSON.stringify(c.arguments ?? {}))
				} catch {
					argLen = 0
				}
				breakdown.toolCall += argLen + TOOLCALL_OVERHEAD
			}
		}
	}
	const tokens = breakdown.text + breakdown.thinking + breakdown.toolCall + breakdown.image + MESSAGE_OVERHEAD
	return { tokens, breakdown }
}

/**
 * @typedef {object} PerMessageEntry
 * @property {number} index                 position in the original messages array
 * @property {string} role                  user | assistant | toolResult | (custom)
 * @property {"text"|"thinking"|"toolCall"|"toolResult"|"compaction"|"compactionSummary"|"compactionMemento"|"branchSummary"|"projectContext"|"empty"} kind
 * @property {number} tokens                approximate token cost of this message
 * @property {{ text: number, thinking: number, toolCall: number, image: number }} parts
 * @property {string} [preview]             short snippet for display (≤80 chars)
 * @property {string} [toolName]            for toolResult / assistant turns with a single toolCall
 * @property {number} [removedCount]        for compaction markers
 * @property {number} [keptCount]
 * @property {number} [mementoCount]
 * @property {number} [tokensBefore]
 */

/**
 * @typedef {object} ContextBreakdown
 * @property {number} system                tokens used by the system prompt
 * @property {number} tools                 tokens used by ALL tool definitions (combined)
 * @property {number} toolCount             how many tools are registered
 * @property {Array<{ name: string, tokens: number }>} toolBreakdown
 * @property {number} messagesTotal         sum of perMessage[].tokens
 * @property {number} total                 system + tools + messagesTotal
 * @property {PerMessageEntry[]} perMessage
 */

/**
 * Compute a structured breakdown of the current context window contents.
 *
 * @param {object} input
 * @param {any[]} [input.messages]
 * @param {string} [input.systemPrompt]
 * @param {any[]} [input.tools]
 * @returns {ContextBreakdown}
 */
export function breakdownContext({ messages = [], systemPrompt = "", tools = [] } = {}) {
	const system = systemPrompt ? tokenize(systemPrompt) + MESSAGE_OVERHEAD : 0
	const toolBreakdown = tools.map((t) => ({ name: t?.name ?? "?", tokens: toolTokens(t) }))
	const toolsTotal = toolBreakdown.reduce((a, b) => a + b.tokens, 0)

	const perMessage = messages.map((m, index) => /** @type {PerMessageEntry} */ (entryFor(m, index)))
	const messagesTotal = perMessage.reduce((a, b) => a + b.tokens, 0)
	const total = system + toolsTotal + messagesTotal

	return {
		system,
		tools: toolsTotal,
		toolCount: tools.length,
		toolBreakdown,
		messagesTotal,
		total,
		perMessage,
	}
}

/**
 * Total estimated token cost for messages alone (no system prompt, no tools).
 * Kept around for back-compat with the few call sites that explicitly want
 * the message-only estimate (e.g. compact()'s `tokensBefore` baseline, which
 * historically reflected only what got summarized away).
 *
 * @param {any[]} messages
 * @returns {number}
 */
export function estimateMessageTokens(messages) {
	return messages.reduce((sum, m) => sum + messageTokens(m).tokens, 0)
}

/**
 * Backwards-compat shim for the original `estimateTokens(messages)` callers.
 * Note: this still ignores systemPrompt/tools — use `breakdownContext` for
 * a complete picture.
 *
 * @param {any[]} messages
 * @returns {number}
 */
export function estimateTokens(messages) {
	return estimateMessageTokens(messages)
}

/**
 * @param {any} m
 * @param {number} index
 * @returns {PerMessageEntry}
 */
function entryFor(m, index) {
	const { tokens, breakdown } = messageTokens(m)
	const role = m.role ?? "custom"
	/** @type {PerMessageEntry["kind"]} */
	let kind = "empty"
	if (m.compaction === true) kind = "compaction"
	else if (isCompactionSummaryMessage(m)) kind = "compactionSummary"
	else if (m.pinanoCompactionMemento === true) kind = "compactionMemento"
	else if (m.branchSummary === true) kind = "branchSummary"
	else if (role === "user" && isProjectContextMessage(m)) kind = "projectContext"
	else if (role === "toolResult") kind = "toolResult"
	else if (Array.isArray(m.content)) {
		if (m.content.some((/** @type any */ c) => c?.type === "toolCall")) kind = "toolCall"
		else if (m.content.some((/** @type any */ c) => c?.type === "thinking")) kind = "thinking"
		else if (m.content.some((/** @type any */ c) => c?.type === "text" && c.text)) kind = "text"
	} else if (typeof m.content === "string" && m.content) {
		kind = "text"
	}

	const preview = previewOf(m)

	/** @type {PerMessageEntry} */
	const entry = {
		index,
		role,
		kind,
		tokens,
		parts: breakdown,
	}
	if (preview) entry.preview = preview
	if (role === "toolResult" && m.toolName) entry.toolName = m.toolName
	if (kind === "toolCall") {
		const firstCall = m.content?.find((/** @type any */ c) => c?.type === "toolCall")
		if (firstCall?.name) entry.toolName = firstCall.name
	}
	if (isCompactionCheckpointMessage(m)) {
		entry.removedCount = m.removedCount
		entry.keptCount = m.keptCount
		entry.mementoCount = m.mementoCount
		entry.tokensBefore = m.tokensBefore
	}
	return entry
}

/**
 * @param {any} m
 * @returns {string | undefined}
 */
function previewOf(m) {
	if (typeof m.content === "string") return clip(m.content)
	if (!Array.isArray(m.content)) return undefined
	const firstText = m.content.find((/** @type any */ c) => c?.type === "text" && c.text)
	if (firstText) return clip(firstText.text)
	const firstThinking = m.content.find((/** @type any */ c) => c?.type === "thinking" && c.thinking)
	if (firstThinking) return clip(firstThinking.thinking)
	return undefined
}

/**
 * @param {string} s
 * @returns {string}
 */
function clip(s) {
	const oneLine = s.replace(/\s+/g, " ").trim()
	return oneLine.length > 80 ? `${oneLine.slice(0, 77)}…` : oneLine
}
