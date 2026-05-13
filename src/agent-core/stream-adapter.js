// Adapter from the agent-loop's stream signature (`reasoning: ThinkingLevel`,
// no provider knobs) onto ai-apis's `stream`/`complete` functions
// (`reasoningEffort`, no `xhigh`, no thinkingBudgets/transport).

import { stream as openaiStream } from "../ai-apis/index.js"

/** @param {import("./types.js").ThinkingLevel} [level] */
function toReasoningEffort(level) {
	if (!level || level === "off") return undefined
	return level
}

/**
 * Default stream function used by the agent-core when none is provided.
 * Accepts the same options as the loop config (`reasoning`, `signal`, `apiKey`, …).
 *
 * @param {import("./types.js").Model} model
 * @param {import("./types.js").Context} context
 * @param {object} [options]
 */
export function streamSimple(model, context, options = {}) {
	const { reasoning, thinkingBudgets, transport, ...rest } = options
	void thinkingBudgets
	void transport
	const reasoningEffort = toReasoningEffort(reasoning) ?? options.reasoningEffort
	return openaiStream(model, context, { ...rest, reasoningEffort })
}
