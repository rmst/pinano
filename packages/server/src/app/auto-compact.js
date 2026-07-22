// Build a `transformContext` callback that runs auto-compaction just before
// each LLM call.
//
// Always starts from `agent.state.messages` (the canonical post-compaction
// conversation view), never the param `messages`. The agent-loop carries its
// own `currentContext.messages` snapshot which mirrors agent state via
// `processEvents` push-on-message_end. After a successful compaction
// `agent.state.messages` is reassigned to the compacted array while the
// loop-local snapshot keeps its old reference + stale bloated prefix. Returning
// the canonical view, with active project context injected, keeps subsequent
// in-turn iterations (assistant continuation after tool results, follow-ups,
// steering) from regressing back to stale history. Worker-backed agents return
// conversation only here because the service injects context at the model I/O
// boundary; compaction estimates still include the pinned context snapshot.

import { compact, shouldCompact } from "./compaction.js"
import { modelCompactionHandoffMessage } from "./compaction-summary.js"
import { buildModelMessagesForAgent } from "./session-context.js"
import { isAutomatedMaintenanceMessage } from "./session-properties.js"

/** @typedef {import("../agent-core/agent.js").Agent} Agent */

/** @param {any[]} messages */
function automatedMaintenanceExchangeActive(messages) {
	if (!Array.isArray(messages)) return false
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]
		if (message?.role === "user") return isAutomatedMaintenanceMessage(message) && Boolean(message.pinanoMaintenance)
	}
	return false
}

/**
 * @param {() => Agent} getAgent
 * @param {() => number} getThreshold
 * @returns {(messages: any[], signal?: AbortSignal) => Promise<any[]>}
 */
export function makeAutoCompactTransform(getAgent, getThreshold) {
	return async (messages, signal) => {
		const agent = getAgent()
		const modelMessages = () => agent.streamFn?.serviceMediated
			? agent.state.messages.map(modelCompactionHandoffMessage)
			: buildModelMessagesForAgent(agent, agent.state.messages)
		if (signal?.aborted) return modelMessages()
		if (automatedMaintenanceExchangeActive(agent.state.messages) || automatedMaintenanceExchangeActive(messages)) return modelMessages()
		if (!shouldCompact(agent, getThreshold())) return modelMessages()
		try {
			await compact(agent, undefined, signal)
		} catch (err) {
			// Surface failures through stderr capture — silent swallowing here historically
			// masked the case where the prefix to summarize was itself too big
			// for one API call, leaving an un-compacted (oversize) request to
			// go out and 400 instead.
			console.error("autocompact failed:", err instanceof Error ? err.message : err)
			throw err
		}
		return modelMessages()
	}
}
