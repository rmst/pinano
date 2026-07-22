// Model-facing compaction summary helpers.
//
// The transcript renderer has its own visual treatment for compaction markers;
// this module describes how compaction is framed to the model. Keep the
// wording focused on continuation quality rather than UI presentation.

export const SUMMARY_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`

export const SUMMARY_USER_PREAMBLE = "Create a context checkpoint handoff from the transcript segment below. This checkpoint will replace that segment in future model context."

export const MODEL_HANDOFF_PREFIX = "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:"

/** @param {any} message */
export function isCompactionSummaryMessage(message) {
	return message?.pinanoCompactionSummary === true
}

/** @param {any} message */
export function isCompactionCheckpointMessage(message) {
	return message?.compaction === true || message?.pinanoRemoteCompaction === true || isCompactionSummaryMessage(message)
}

/** @param {any} message */
export function compactionSummaryText(message) {
	const content = message?.content
	if (typeof content === "string") return content.trim()
	if (!Array.isArray(content)) return ""
	return content
		.filter((/** @type {any} */ block) => block.type === "text" && block.text?.trim())
		.map((/** @type {any} */ block) => block.text.trim())
		.filter(Boolean)
		.join("\n\n")
}

/** @param {any} message */
export function compactionMarkerMetaParts(message) {
	const removed = message?.removedCount ?? 0
	const kept = message?.keptCount ?? 0
	const mementos = typeof message?.mementoCount === "number" ? message.mementoCount : undefined
	const tokens = message?.tokensBefore ?? 0
	const metaParts = []
	if (removed > 0) metaParts.push(`${removed} message${removed === 1 ? "" : "s"} compacted`)
	if (mementos !== undefined) metaParts.push(`${mementos} user message${mementos === 1 ? "" : "s"} retained`)
	else if (message?.remoteCompaction === true && kept > 0) metaParts.push(`${kept} user message${kept === 1 ? "" : "s"} retained`)
	else if (kept > 0) metaParts.push(`${kept} kept`)
	if (mementos !== undefined && kept > 0) metaParts.push(`${kept} provider checkpoint${kept === 1 ? "" : "s"}`)
	if (tokens > 0) metaParts.push(`~${tokens} tok`)
	return metaParts
}

/** @param {any} message */
export function compactionMarkerLabel(message) {
	const metaParts = compactionMarkerMetaParts(message)
	const meta = metaParts.length > 0 ? ` (${metaParts.join(", ")})` : ""
	return `earlier context compacted${meta}`
}

/** @param {any} message */
export function compactionMarkerBody(message) {
	return compactionSummaryText(message)
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
		content: [{ type: "text", text: `${MODEL_HANDOFF_PREFIX}\n${summary || "(no compaction summary available)"}` }],
		pinanoCompactionSummary: true,
	}
	if (usage !== undefined) {
		handoff.usage = usage && typeof usage === "object"
			? { ...usage, cost: usage.cost && typeof usage.cost === "object" ? { ...usage.cost } : usage.cost }
			: usage
	}
	return handoff
}
