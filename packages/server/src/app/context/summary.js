import { isCompactionCheckpointMessage } from "../compaction-summary.js"
import { breakdownContext, estimateMessageTokens } from "./accounting.js"

/** @param {number | undefined | null} value */
function finiteOrZero(value) {
	return Number.isFinite(value) ? value : 0
}

/** @param {number | undefined | null} value */
function positiveFiniteOrZero(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Provider usage has separate input and output sides, while context pressure
 * for the next request is about the input side. Prefer raw provider prompt
 * counts when available; older/synthetic entries only have totalTokens, so
 * those remain the compatibility fallback.
 * @param {any} usage
 * @returns {number}
 */
export function usageContextTokens(usage) {
	const rawInput = positiveFiniteOrZero(usage?.raw?.input_tokens ?? usage?.raw?.prompt_tokens)
	if (rawInput) return rawInput
	const normalizedInput = positiveFiniteOrZero(usage?.input) + positiveFiniteOrZero(usage?.cacheRead) + positiveFiniteOrZero(usage?.cacheWrite)
	if (normalizedInput) return normalizedInput
	return positiveFiniteOrZero(usage?.totalTokens)
}

/**
 * Find the freshest known context baseline.
 *
 * A provider-reported assistant usage describes the request that produced that
 * assistant turn, so the assistant message itself and anything after it are
 * unreported delta for the next request. A Pinano compaction checkpoint stores
 * a post-compaction estimate that already includes the checkpoint message, so
 * its delta starts after the checkpoint.
 *
 * @param {any[]} messages
 * @returns {{ tokens: number, messageIndex: number, deltaStartIndex: number, source: "provider" | "compaction" } | undefined}
 */
export function latestContextBaseline(messages) {
	let compactionTs = 0
	/** @type {{ tokens: number, messageIndex: number, deltaStartIndex: number, source: "compaction" } | undefined} */
	let fallback
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i]
		if (!isCompactionCheckpointMessage(message)) continue
		if (message.timestamp) compactionTs = message.timestamp
		const tokens = usageContextTokens(message.usage)
		if (tokens) fallback = { tokens, messageIndex: i, deltaStartIndex: i + 1, source: "compaction" }
	}
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]
		if (message.role !== "assistant") continue
		if (isCompactionCheckpointMessage(message)) continue
		const tokens = usageContextTokens(message.usage)
		if (!tokens) continue
		if (compactionTs && (message.timestamp ?? 0) < compactionTs) continue
		return { tokens, messageIndex: i, deltaStartIndex: i, source: "provider" }
	}
	return fallback
}

/**
 * Compute the current model-context pressure. The provider/synthetic baseline
 * covers the already-counted prefix; local estimation only covers messages
 * appended since that baseline. A full local estimate remains as a fallback
 * and sanity check for sessions with no provider usage or unusual prompt
 * overhead.
 * @param {object} input
 * @param {any[]} [input.messages]
 * @param {string} [input.systemPrompt]
 * @param {any[]} [input.tools]
 */
export function estimateContextUse({ messages = [], systemPrompt = "", tools = [] } = {}) {
	const breakdown = breakdownContext({ messages, systemPrompt, tools })
	const baseline = latestContextBaseline(messages)
	const reportedTokens = baseline?.tokens ?? 0
	const reportedDeltaTokens = baseline ? estimateMessageTokens(messages.slice(baseline.deltaStartIndex)) : 0
	const reportedWithDeltaTokens = reportedTokens + reportedDeltaTokens
	return {
		breakdown,
		estimatedTokens: breakdown.total,
		reportedTokens,
		reportedDeltaTokens,
		reportedWithDeltaTokens,
		usedTokens: Math.max(breakdown.total, reportedWithDeltaTokens),
		baseline,
	}
}

/** Last reported context baseline from any prior assistant/compaction message, or 0.
 *
 * After a compaction, assistant messages kept in the tail still carry their
 * pre-compaction `totalTokens`, a number that reflects a prompt size that no
 * longer exists. We ignore those and fall back to the compaction marker's own
 * estimate until a fresh post-compaction turn reports real usage.
 * @param {any[]} messages
 * @returns {number} */
export function lastReportedTokens(messages) {
	return latestContextBaseline(messages)?.tokens ?? 0
}

/** @param {any[]} messages */
export function summarizeMessageBilling(messages = []) {
	let costTotal = 0
	let lastTotalTokens = 0
	let compactionTs = 0
	let compactionEstimateTokens = 0
	for (const msg of messages) {
		if (isCompactionCheckpointMessage(msg)) {
			compactionTs = msg.timestamp ?? 0
			compactionEstimateTokens = msg.usage?.totalTokens ?? 0
			costTotal += msg.usage?.cost?.total ?? 0
			continue
		}
		if (msg?.role !== "assistant") continue
		const usage = msg.usage
		if (!usage) continue
		costTotal += usage.cost?.total ?? 0
		if (compactionTs && (msg.timestamp ?? 0) < compactionTs) continue
		if (usage.totalTokens) lastTotalTokens = usage.totalTokens
	}
	if (!lastTotalTokens) lastTotalTokens = compactionEstimateTokens
	return { costTotal, lastTotalTokens }
}

/**
 * @param {object} input
 * @param {any[]} [input.messages]
 * @param {string} [input.systemPrompt]
 * @param {any[]} [input.tools]
 */
export function summarizeContext({ messages = [], systemPrompt = "", tools = [] } = {}) {
	const usage = estimateContextUse({ messages, systemPrompt, tools })
	const breakdown = usage.breakdown
	const billing = summarizeMessageBilling(messages)
	return {
		messageCount: messages.length,
		systemTokens: breakdown.system,
		toolTokens: breakdown.tools,
		toolCount: breakdown.toolCount,
		messageTokens: breakdown.messagesTotal,
		estimatedTokens: usage.estimatedTokens,
		reportedTokens: usage.reportedTokens,
		reportedDeltaTokens: usage.reportedDeltaTokens,
		reportedWithDeltaTokens: usage.reportedWithDeltaTokens,
		lastTotalTokens: billing.lastTotalTokens,
		usedTokens: usage.usedTokens,
		costTotal: billing.costTotal,
	}
}

/**
 * Advance compact context stats after an event appends one normal model message.
 * This keeps snapshot-backed UIs reactive during a turn without retaining the
 * full hidden context message array client-side.
 * @param {any | undefined} stats
 * @param {any} message
 */
export function appendMessageToContextStats(stats, message) {
	if (!stats || !message) return stats
	const delta = breakdownContext({ messages: [message] }).messagesTotal
	const messageTokens = finiteOrZero(stats.messageTokens) + delta
	const estimatedTokens = finiteOrZero(stats.estimatedTokens) + delta
	let reportedTokens = finiteOrZero(stats.reportedTokens)
	let reportedDeltaTokens = finiteOrZero(stats.reportedDeltaTokens)
	const messageReportedTokens = usageContextTokens(message.usage)
	if (isCompactionCheckpointMessage(message) && messageReportedTokens) {
		reportedTokens = messageReportedTokens
		reportedDeltaTokens = 0
	} else if (message.role === "assistant" && messageReportedTokens) {
		reportedTokens = messageReportedTokens
		reportedDeltaTokens = delta
	} else if (reportedTokens) {
		reportedDeltaTokens += delta
	}
	const lastTotalTokens = message.role === "assistant" && message.usage?.totalTokens
		? message.usage.totalTokens
		: finiteOrZero(stats.lastTotalTokens)
	const costTotal = finiteOrZero(stats.costTotal) + (message.role === "assistant" ? finiteOrZero(message.usage?.cost?.total) : 0)
	const reportedWithDeltaTokens = reportedTokens + reportedDeltaTokens
	return {
		...stats,
		messageCount: finiteOrZero(stats.messageCount) + 1,
		messageTokens,
		estimatedTokens,
		reportedTokens,
		reportedDeltaTokens,
		reportedWithDeltaTokens,
		lastTotalTokens,
		usedTokens: Math.max(reportedWithDeltaTokens, estimatedTokens),
		costTotal,
	}
}
