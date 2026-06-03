import { isCompactionCheckpointMessage } from "./compaction-summary.js"
import { breakdownContext } from "./context-accounting.js"

/** @param {number | undefined | null} value */
function finiteOrZero(value) {
	return Number.isFinite(value) ? value : 0
}

/** Last reported usage from any prior assistant message, or 0.
 *
 * After a compaction, assistant messages kept in the tail still carry their
 * pre-compaction `totalTokens`, a number that reflects a prompt size that no
 * longer exists. We ignore those and fall back to the compaction marker's own
 * estimate until a fresh post-compaction turn reports real usage.
 * @param {any[]} messages
 * @returns {number} */
export function lastReportedTokens(messages) {
	let compactionTs = 0
	for (const message of messages) {
		if (isCompactionCheckpointMessage(message) && message.timestamp) compactionTs = message.timestamp
	}
	let fallback = 0
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]
		if (isCompactionCheckpointMessage(message)) {
			if (!fallback) fallback = message.usage?.totalTokens ?? 0
			continue
		}
		if (message.role !== "assistant") continue
		if (!message.usage?.totalTokens) continue
		if (compactionTs && (message.timestamp ?? 0) < compactionTs) continue
		return message.usage.totalTokens
	}
	return fallback
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
	const breakdown = breakdownContext({ messages, systemPrompt, tools })
	const reportedTokens = lastReportedTokens(messages)
	const billing = summarizeMessageBilling(messages)
	return {
		messageCount: messages.length,
		systemTokens: breakdown.system,
		toolTokens: breakdown.tools,
		toolCount: breakdown.toolCount,
		messageTokens: breakdown.messagesTotal,
		estimatedTokens: breakdown.total,
		reportedTokens,
		lastTotalTokens: billing.lastTotalTokens,
		usedTokens: Math.max(reportedTokens, billing.lastTotalTokens, breakdown.total),
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
	const reportedTokens = message.role === "assistant" && message.usage?.totalTokens
		? message.usage.totalTokens
		: finiteOrZero(stats.reportedTokens)
	const lastTotalTokens = message.role === "assistant" && message.usage?.totalTokens
		? message.usage.totalTokens
		: finiteOrZero(stats.lastTotalTokens)
	const costTotal = finiteOrZero(stats.costTotal) + (message.role === "assistant" ? finiteOrZero(message.usage?.cost?.total) : 0)
	return {
		...stats,
		messageCount: finiteOrZero(stats.messageCount) + 1,
		messageTokens,
		estimatedTokens,
		reportedTokens,
		lastTotalTokens,
		usedTokens: Math.max(reportedTokens, lastTotalTokens, estimatedTokens),
		costTotal,
	}
}
