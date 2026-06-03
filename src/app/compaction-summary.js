// Model-facing compaction summary helpers.
//
// The transcript renderer has its own visual treatment for compaction markers;
// this module describes how compaction is framed to the model. Keep the
// wording focused on continuation quality rather than UI presentation.

export const COMPACTION_MARKER_PREFIX = "[earlier context compacted]"
export const COMPACTION_SUMMARY_DISPLAY_MAX_LINES = 10

export const SUMMARY_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION for a coding-agent conversation. Create a handoff summary for a future model call that will resume the task after the older transcript is replaced.

Write a detailed but compact, structured summary. Preserve all information needed to continue the work without reading the replaced transcript again.

Use these headings:
- Current goal and user intent
- Current progress and key decisions made
- Important constraints, project instructions, user preferences, and assumptions
- Files, functions, commands, tools, APIs, data shapes, IDs, or error messages that matter for follow-up
- Work completed so far and the evidence/results that matter
- What remains to be done, with clear next steps
- Open questions, blockers, failed attempts, or risks

Guidelines:
- Prefer preserving exact names, paths, commands, and error text over vague prose.
- If a previous compaction/handoff summary appears in the transcript, fold its durable facts into this checkpoint; do not summarize away important earlier state.
- Be compact, but do not omit details that a future model would need to continue safely.

Reply with the handoff summary only. No greetings, no code fences.`

export const SUMMARY_USER_PREAMBLE = "Create a context checkpoint handoff from the transcript segment below. This checkpoint will replace that segment in future model context."

export const MODEL_HANDOFF_PREFIX = `The earlier conversation was compacted. Treat this as an authoritative handoff checkpoint for continuing the task. It may include facts carried forward from previous compactions; preserve them unless superseded by later context.`

/** @param {any} message */
export function isCompactionSummaryMessage(message) {
	return message?.pinanoCompactionSummary === true
}

/** @param {any} message */
export function isCompactionCheckpointMessage(message) {
	return message?.compaction === true || isCompactionSummaryMessage(message)
}

/** @param {string} text */
export function stripCompactionMarkerPrefix(text) {
	let stripped = text.replace(/^\[earlier context compacted\]\n?/, "")
	if (stripped.startsWith(MODEL_HANDOFF_PREFIX)) stripped = stripped.slice(MODEL_HANDOFF_PREFIX.length)
	return stripped.trim()
}

/** @param {string} text @param {number} [maxLines] */
export function truncateCompactionSummaryForDisplay(text, maxLines = COMPACTION_SUMMARY_DISPLAY_MAX_LINES) {
	const normalized = String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim()
	if (!normalized) return ""
	if (maxLines <= 0) return ""
	const lines = normalized.split("\n")
	if (lines.length <= maxLines) return normalized
	const omitted = lines.length - maxLines
	return [...lines.slice(0, maxLines), `... ${omitted} more line${omitted === 1 ? "" : "s"}`].join("\n")
}

/** @param {any} message */
export function compactionSummaryText(message) {
	const content = message?.content
	if (typeof content === "string") return stripCompactionMarkerPrefix(content)
	if (!Array.isArray(content)) return ""
	return content
		.filter((/** @type {any} */ block) => block.type === "text" && block.text?.trim())
		.map((/** @type {any} */ block) => stripCompactionMarkerPrefix(block.text))
		.filter(Boolean)
		.join("\n\n")
}

/** @param {any} message */
export function modelCompactionHandoffMessage(message) {
	if (isCompactionSummaryMessage(message)) return message
	if (message?.compaction !== true) return message
	const summary = compactionSummaryText(message)
	const { compaction, usage, ...rest } = message
	void compaction
	const handoff = {
		...rest,
		role: "user",
		content: [{ type: "text", text: `${MODEL_HANDOFF_PREFIX}\n\n${summary || "(no compaction summary available)"}` }],
		pinanoCompactionSummary: true,
	}
	if (usage !== undefined) {
		handoff.usage = usage && typeof usage === "object"
			? { ...usage, cost: usage.cost && typeof usage.cost === "object" ? { ...usage.cost } : usage.cost }
			: usage
	}
	return handoff
}
