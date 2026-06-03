import { breakdownContext } from "./context-accounting.js"
import { lastReportedTokens } from "./context-summary.js"

/**
 * @param {number} n
 * @returns {string}
 */
export function formatTokens(n) {
	if (n >= 100_000) return `${(n / 1000).toFixed(0)}k`
	if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`
	if (n >= 1000) return `${(n / 1000).toFixed(2)}k`
	return `${n}`
}

/**
 * @param {number} cur
 * @param {number} max
 * @param {number} [width]
 * @returns {string}
 */
function bar(cur, max, width = 30) {
	if (max <= 0) return ""
	const filled = Math.min(width, Math.round((cur / max) * width))
	return "█".repeat(filled) + "░".repeat(width - filled)
}

/**
 * @param {string} role
 * @returns {string}
 */
function roleLabel(role) {
	if (role === "assistant") return "asst "
	if (role === "toolResult") return "tool "
	if (role === "user") return "user "
	return role.padEnd(5).slice(0, 5)
}

/**
 * @param {import("./context-accounting.js").PerMessageEntry} entry
 * @returns {string}
 */
function entrySummary(entry) {
	if (entry.kind === "compaction") {
		const parts = [`${entry.removedCount ?? "?"} compacted`]
		if (typeof entry.mementoCount === "number") parts.push(`${entry.mementoCount} user message${entry.mementoCount === 1 ? "" : "s"} retained`)
		else if ((entry.keptCount ?? 0) > 0) parts.push(`${entry.keptCount} kept`)
		if (typeof entry.mementoCount === "number" && (entry.keptCount ?? 0) > 0) parts.push(`${entry.keptCount} provider checkpoint${entry.keptCount === 1 ? "" : "s"}`)
		return `[compaction marker · ${parts.join(" · ")}]`
	}
	if (entry.kind === "compactionMemento") return "[retained user memento]"
	if (entry.kind === "branchSummary") return "[branch summary]"
	if (entry.kind === "projectContext") return "[AGENTS.md / CLAUDE.md]"
	if (entry.kind === "toolCall" && entry.toolName) return `→ ${entry.toolName}(…)`
	if (entry.kind === "toolResult") return `← ${entry.toolName ?? "?"}`
	if (entry.kind === "thinking") return "(thinking)"
	return entry.kind === "empty" ? "(empty)" : "text"
}

/**
 * @param {import("./context-accounting.js").PerMessageEntry} entry
 * @returns {string[]}
 */
function entryLines(entry) {
	const idx = String(entry.index).padStart(3)
	const role = roleLabel(entry.role)
	const tok = formatTokens(entry.tokens).padStart(7)
	const lines = [`  [${idx}] ${role} ${tok} tok   ${entrySummary(entry)}`]
	if (entry.preview) lines.push(`       ${entry.preview}`)
	return lines
}

/**
 * @param {import("./context-accounting.js").ContextBreakdown} breakdown
 * @returns {Array<{role: string, tokens: number}>}
 */
function rollupByRole(breakdown) {
	const buckets = new Map()
	for (const entry of breakdown.perMessage) {
		const key = entry.kind === "compaction" || entry.kind === "compactionMemento" || entry.kind === "branchSummary" || entry.kind === "projectContext"
			? entry.kind
			: entry.role
		buckets.set(key, (buckets.get(key) ?? 0) + entry.tokens)
	}
	return [...buckets.entries()]
		.map(([role, tokens]) => ({ role, tokens }))
		.sort((a, b) => b.tokens - a.tokens)
}

/**
 * @param {string} role
 * @returns {string}
 */
function rollupLabel(role) {
	if (role === "compaction") return "compaction marker"
	if (role === "compactionMemento") return "retained user mementos"
	if (role === "branchSummary") return "branch summary"
	if (role === "projectContext") return "project context"
	if (role === "toolResult") return "tool results"
	if (role === "assistant") return "assistant turns"
	if (role === "user") return "user messages"
	return role
}

/**
 * @param {object} input
 * @param {any[]} [input.messages]
 * @param {string} [input.systemPrompt]
 * @param {any[]} [input.tools]
 * @param {any} [input.model]
 * @returns {string[]}
 */
export function formatContextReport({ messages = [], systemPrompt = "", tools = [], model } = {}) {
	const contextWindow = /** @type {number} */ (model?.contextWindow ?? 0)
	const breakdown = breakdownContext({ messages, systemPrompt, tools })
	const reported = lastReportedTokens(messages)
	const used = Math.max(reported, breakdown.total)
	const pct = (n) => contextWindow > 0 ? `${Math.min(100, Math.round((n / contextWindow) * 100))}%` : "—"

	const lines = [
		`Window         ${formatTokens(used)} / ${formatTokens(contextWindow)} tok  (${pct(used)})`,
		`               ${bar(used, contextWindow)}`,
		`  live estimate (≈4 char/tok):   ${formatTokens(breakdown.total)} tok`,
		`  last reported (provider count): ${reported > 0 ? formatTokens(reported) + " tok" : "—"}`,
		"",
		"Breakdown",
		`  system prompt                ${formatTokens(breakdown.system).padStart(7)} tok`,
		`  tool definitions (${breakdown.toolCount})         ${formatTokens(breakdown.tools).padStart(7)} tok`,
	]

	for (const item of rollupByRole(breakdown)) {
		lines.push(`  ${rollupLabel(item.role).padEnd(28)} ${formatTokens(item.tokens).padStart(7)} tok`)
	}
	lines.push("")

	const biggestTools = [...breakdown.toolBreakdown]
		.sort((a, b) => b.tokens - a.tokens)
		.slice(0, 5)
	if (biggestTools.length > 0) {
		lines.push("Largest tools")
		for (const tool of biggestTools) {
			const name = String(tool.name ?? "?").padEnd(24).slice(0, 24)
			lines.push(`  ${name} ${formatTokens(tool.tokens).padStart(7)} tok`)
		}
		lines.push("")
	}

	const top = [...breakdown.perMessage]
		.filter((entry) => entry.kind !== "empty")
		.sort((a, b) => b.tokens - a.tokens)
		.slice(0, 5)
	if (top.length > 0) {
		lines.push("Largest entries")
		for (const entry of top) lines.push(...entryLines(entry))
		lines.push("")
	}

	const log = breakdown.perMessage.slice(-20)
	lines.push(log.length < breakdown.perMessage.length ? `Order  (last ${log.length} of ${breakdown.perMessage.length})` : "Order")
	for (const entry of log) lines.push(...entryLines(entry))
	lines.push(
		"",
		"  notes:  the live estimate uses a 4-char/tok heuristic;",
		"          the real tokenizer can differ ±30% (more for code/CJK).",
		"          cache reads/writes count toward the window but are billed less.",
	)
	return lines
}
