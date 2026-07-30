// Durable session run-state derivation.
//
// The service should not have bespoke "resume" logic that reverse-engineers a
// transcript shape. Instead it asks this reducer what the next executable action
// is from the append-only session branch. Normal /continue and service recovery
// can then use the same answer.

import { nextAgentAction } from "../../agent-core/agent-loop.js"
import { conversationEntriesForModel } from "./context.js"

/** @param {any} entry */
function toolExecutionData(entry) {
	return entry?.type === "custom" && entry.customType === "tool_execution" ? entry.data ?? {} : undefined
}

function toolExecutionHasDurableResult(data) {
	if (!data?.toolCallId) return false
	if (data.phase !== "ended" && data.phase !== "recovered_unknown") return false
	return data.hasDurableMessage === true || !!data.messageEntryId
}

function unknownToolResultMessage(tool) {
	const toolName = tool.toolName || "unknown"
	const text = [
		`The agent harness crashed while tool call ${tool.toolCallId} (${toolName}) was running.`,
		"The tool's effects may have been partially applied, fully applied, or not applied at all.",
		"Do not assume success or failure. Inspect the relevant state carefully before proceeding.",
	].join("\n")
	return {
		role: "toolResult",
		toolCallId: tool.toolCallId,
		toolName,
		content: [{ type: "text", text }],
		details: {
			reason: "agent_harness_crashed_during_tool",
			toolCallId: tool.toolCallId,
			toolName,
			args: tool.args,
			startedEntryId: tool.entryId,
		},
		isError: true,
		timestamp: Date.now(),
	}
}

/**
 * Tool starts are durable because they are the boundary where repeating work can
 * have side effects. A start without a matching durable end/result is not safe
 * to execute again; callers should first synthesize an explicit unknown/error
 * tool result so the model can inspect and reconcile instead of repeating it. A
 * missing start simply means the tool call was requested but not yet begun, and
 * normal continuation may execute it.
 * @param {import("../../session-manager/index.js").Session} session
 */
export function startedToolsWithoutDurableResult(session) {
	const branch = session.getBranch()
	const started = new Map()
	const ended = new Set()
	const results = new Set()
	for (const entry of branch) {
		const data = toolExecutionData(entry)
		if (data?.phase === "started" && data.toolCallId) {
			started.set(data.toolCallId, {
				toolCallId: data.toolCallId,
				toolName: data.toolName,
				args: data.args,
				entryId: entry.id,
			})
		}
		if (toolExecutionHasDurableResult(data)) ended.add(data.toolCallId)
		if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolCallId) {
			results.add(entry.message.toolCallId)
		}
	}
	return [...started.values()].filter((tool) => !ended.has(tool.toolCallId) && !results.has(tool.toolCallId))
}

/**
 * Convert tools that were durably started before a crash but have no durable
 * result into explicit error tool results. This preserves the invariant that an
 * assistant tool call is answered exactly once, while avoiding an unsafe repeat
 * of side-effecting work whose outcome is unknown.
 * @param {import("../../session-manager/index.js").Session} session
 * @returns {Promise<any[]>}
 */
export async function synthesizeUnknownToolResultsForStartedTools(session) {
	const pending = startedToolsWithoutDurableResult(session)
	const messages = []
	for (const tool of pending) {
		const message = unknownToolResultMessage(tool)
		const messageEntryId = await session.appendMessage(message)
		await session.appendCustomEntry("tool_execution", {
			version: 2,
			phase: "recovered_unknown",
			toolCallId: tool.toolCallId,
			toolName: tool.toolName,
			args: tool.args,
			startedEntryId: tool.entryId,
			messageEntryId,
			hasDurableMessage: true,
		})
		messages.push(message)
	}
	return messages
}

/**
 * @param {import("../../session-manager/index.js").Session} session
 * @returns {{ type: "runnable", action: ReturnType<typeof nextAgentAction> } | { type: "blocked", reason: string, pendingToolCalls?: any[] } | { type: "idle", reason: string }}
 */
export function deriveSessionRunState(session) {
	const pendingToolCalls = startedToolsWithoutDurableResult(session)
	if (pendingToolCalls.length > 0) return { type: "blocked", reason: "tool_execution_unknown", pendingToolCalls }

	const logical = conversationEntriesForModel(session)
	const messages = logical.map((entry) => entry.message)
	const action = nextAgentAction(messages)
	if (action.type !== "wait_for_user") return { type: "runnable", action }

	return { type: "idle", reason: action.reason }
}
