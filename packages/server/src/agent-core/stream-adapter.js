// Adapter from the agent-loop's stream signature (`reasoning: ThinkingLevel`,
// no provider knobs) onto ai-apis's `stream`/`complete` functions.

import { stream as openaiStream } from "../ai-apis/index.js"
import { normalizeReasoningLevel, reasoningEffortForApi } from "../../../protocol/src/reasoning.js"

function modelDefaultReasoningEffort(model, reasoning) {
	return normalizeReasoningLevel(reasoning) === "default" && typeof model?.defaultReasoningLevel === "string"
		? model.defaultReasoningLevel
		: undefined
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
	const reasoningEffort = reasoningEffortForApi(reasoning) ?? options.reasoningEffort ?? modelDefaultReasoningEffort(model, reasoning)
	return openaiStream(model, context, { ...rest, reasoningEffort })
}
