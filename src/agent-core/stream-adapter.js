// Adapter from the agent-loop's stream signature (`reasoning: ThinkingLevel`,
// no provider knobs) onto ai-apis's `stream`/`complete` functions.

import { stream as openaiStream } from "../ai-apis/index.js"
import { reasoningEffortForApi } from "../reasoning.js"

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
	const reasoningEffort = reasoningEffortForApi(reasoning) ?? options.reasoningEffort
	return openaiStream(model, context, { ...rest, reasoningEffort })
}
