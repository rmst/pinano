import { insertContextAfterLatestResponsesCompaction, messageHasResponsesCompactionItem } from "../responses-compaction.js"
import { modelCompactionHandoffMessage } from "./compaction-summary.js"
import { buildContextBundleMessage, normalizeContextFiles } from "./context-format.js"
import { getEffectiveSessionProperties } from "./session-properties.js"

/** @typedef {{ path: string, scopeDir: string, content: string, hash: string }} ContextSnapshotFile */

/** @param {any} agent */
export function contextFilesDisabledForAgent(agent) {
	return agent?.contextFilesDisabled === true || agent?.session?.getSessionConfig?.().noContextFiles === true
}

/** Return active context files for the current branch. Later loads for the
 * same path replace earlier ones; output order preserves the recorded load
 * order. The startup and lazy loaders already record files in instruction
 * precedence order, so prompt assembly remains an exact replay of snapshots.
 * @param {any} session
 * @param {string} [fromId]
 * @returns {ContextSnapshotFile[]} */
export function activeContextFiles(session, fromId = undefined) {
	const loads = session?.getContextLoads?.(fromId) ?? []
	const byPath = new Map()
	for (const load of loads) {
		if (load.disabled) continue
		for (const file of normalizeContextFiles(load.files ?? [])) byPath.set(file.path, file)
	}
	return [...byPath.values()]
}

function pruneBeforeLatestResponsesCompaction(entries) {
	let latest = -1
	for (let i = 0; i < entries.length; i++) {
		if (messageHasResponsesCompactionItem(entries[i].message)) latest = i
	}
	return latest > 0 ? entries.slice(latest) : entries
}

/** Convert session logical entries into model conversation entries. Compaction
 * is applied, but context-load entries are projected separately. If the active
 * logical history contains provider-native Responses compaction output, keep
 * the latest compaction-bearing turn as the new model prefix and omit older
 * entries for stateless replay latency.
 * @param {any} session
 * @param {string} [fromId]
 * @returns {Array<{ message: any, entryId: string }>} */
export function conversationEntriesForModel(session, fromId = undefined) {
	const retainedMaintenanceToolCallIds = new Set()
	const projectMessage = (message) => {
		if (!message?.pinanoAutomated && !message?.pinanoMaintenance) return message
		if (message.role === "assistant") {
			const toolCalls = Array.isArray(message.content)
				? message.content.filter((block) => block?.type === "toolCall" && block.id)
				: []
			if (toolCalls.length === 0) return undefined
			for (const block of toolCalls) retainedMaintenanceToolCallIds.add(block.id)
			const projected = { ...message, content: toolCalls }
			delete projected.pinanoAutomated
			delete projected.pinanoMaintenance
			return projected
		}
		if (message.role === "toolResult" && retainedMaintenanceToolCallIds.has(message.toolCallId)) {
			const projected = { ...message }
			delete projected.pinanoAutomated
			delete projected.pinanoMaintenance
			return projected
		}
		return undefined
	}
	const entries = (session?.getLogicalEntries?.(fromId) ?? [])
		.flatMap((entry) => {
			const message = projectMessage(entry.message)
			return message ? [{ ...entry, message: modelCompactionHandoffMessage(message) }] : []
		})
	return pruneBeforeLatestResponsesCompaction(entries)
}

/** Build model-visible messages by prefixing a canonical context bundle to
 * the compacted conversation projection.
 * @param {ReadonlyArray<ContextSnapshotFile>} files
 * @param {ReadonlyArray<any>} conversationMessages
 * @param {string} cwd
 * @returns {any[]} */
export function buildModelMessagesWithContextFiles(files, conversationMessages, cwd) {
	const contextMessage = buildContextBundleMessage([...files], cwd)
	return insertContextAfterLatestResponsesCompaction(contextMessage ? [contextMessage] : [], conversationMessages)
}

/** Build the actual model-visible messages for a session by prefixing the
 * canonical context bundle to the compacted conversation projection.
 * @param {any} session
 * @param {ReadonlyArray<any>} conversationMessages
 * @param {string} [cwd]
 * @returns {any[]} */
export function buildModelMessagesForSession(session, conversationMessages, cwd = undefined) {
	const initialCwd = cwd ?? getEffectiveSessionProperties(session).cwd ?? session?.getMetadata?.().cwd ?? process.cwd()
	return buildModelMessagesWithContextFiles(
		activeContextFiles(session),
		conversationMessages,
		initialCwd,
	)
}

function stripStaleAutomatedMessages(messages) {
	const last = messages[messages.length - 1]
	if (last?.pinanoAutomated || last?.pinanoMaintenance) return messages
	return messages.filter((message) => !message?.pinanoAutomated && !message?.pinanoMaintenance)
}

/** @param {any} agent @param {ReadonlyArray<any>} [conversationMessages] @param {string} [cwd] */
export function buildModelMessagesForAgent(agent, conversationMessages = undefined, cwd = undefined) {
	const messages = conversationMessages ?? agent?.state?.messages ?? []
	if (agent?.session) {
		const conversation = stripStaleAutomatedMessages(messages)
		const modelConversation = conversation.map(modelCompactionHandoffMessage)
		if (contextFilesDisabledForAgent(agent)) return modelConversation
		return buildModelMessagesForSession(agent.session, modelConversation, cwd)
	}
	const modelMessages = messages.map(modelCompactionHandoffMessage)
	if (contextFilesDisabledForAgent(agent)) return modelMessages
	const files = agent?.activeContextSnapshotFiles ?? []
	return buildModelMessagesWithContextFiles(files, modelMessages, cwd ?? process.cwd())
}

/** @param {any} session @param {string} [cwd] */
export function buildContextBundleForSession(session, cwd = undefined) {
	return buildContextBundleMessage(activeContextFiles(session), cwd ?? session?.getMetadata?.().cwd ?? process.cwd())
}
