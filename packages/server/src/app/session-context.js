import { insertContextAfterLatestResponsesCompaction, isResponsesCompactionBlock, messageHasResponsesCompactionItem } from "../../../protocol/src/responses-compaction.js"
import { modelCompactionHandoffMessage } from "./compaction-summary.js"
import { contextFileIdentity } from "../session-manager/context-identity.js"
import { buildContextBundleMessage, hashContextContent, normalizeContextFiles } from "./context/format.js"
import { isProjectContextMessage } from "./project-context.js"
import { SESSION_WORKTREE_LIFECYCLE_MAINTENANCE, getEffectiveSessionProperties } from "./session-properties.js"

/** @typedef {{ path: string, scopeDir: string, identityPath: string, content: string, hash: string }} ContextSnapshotFile */

/** @param {any} agent */
export function contextFilesDisabledForAgent(agent) {
	return agent?.contextFilesDisabled === true || agent?.session?.getSessionConfig?.().noContextFiles === true
}

/** Return active context files for the current branch. Later loads for the
 * same real context file replace earlier ones; output order preserves the
 * recorded load order. The startup and lazy loaders already record files in
 * instruction precedence order, so prompt assembly remains an exact replay of
 * snapshots.
 * @param {any} session
 * @param {string} [fromId]
 * @returns {ContextSnapshotFile[]} */
export function activeContextFiles(session, fromId = undefined) {
	const loads = session?.getContextLoads?.(fromId) ?? []
	const byIdentity = new Map()
	for (const load of loads) {
		if (load.disabled) continue
		for (const file of normalizeContextFiles(load.files ?? [])) byIdentity.set(contextFileIdentity(file), file)
	}
	return [...byIdentity.values()]
}

/** Return context snapshots as they should be injected into the model. Durable context state keeps every loaded file, but prompt assembly drops later exact-content duplicates so common worktree copies do not waste context.
 * @param {ReadonlyArray<ContextSnapshotFile | { path: string, content: string, scopeDir?: string, identityPath?: string, hash?: string }>} files
 * @returns {ContextSnapshotFile[]} */
export function contextFilesForModel(files) {
	const seenHashes = new Set()
	return normalizeContextFiles([...files]).filter((file) => {
		const hash = hashContextContent(file.content)
		if (seenHashes.has(hash)) return false
		seenHashes.add(hash)
		return true
	})
}

function pruneBeforeLatestResponsesCompaction(entries) {
	let latest = -1
	for (let i = 0; i < entries.length; i++) {
		if (messageHasResponsesCompactionItem(entries[i].message)) latest = i
	}
	if (latest <= 0) return entries
	return entries.filter((entry, index) => index >= latest || entry.message?.pinanoRemoteCompactionRetained === true)
}

/** @param {any} block */
function isForkedAssistantContentBlock(block) {
	if (block?.type === "text") return true
	if (isResponsesCompactionBlock(block)) return true
	const item = block?.type === "responsesItem" ? block.item : undefined
	return item?.type === "message" && item.role === "assistant" && item.phase !== "commentary"
}

/** @param {any} message */
function sanitizeForkedMessage(message) {
	if (!message) return undefined
	if (isProjectContextMessage(message)) return message
	if (message.role === "toolResult") return undefined
	if (message.role === "assistant") {
		if (message.stopReason === "toolUse" || message.stopReason === "aborted" || message.stopReason === "error" || message.errorMessage) return undefined
		const content = Array.isArray(message.content)
			? message.content.filter(isForkedAssistantContentBlock)
			: typeof message.content === "string"
				? message.content
				: []
		const hasContent = typeof content === "string" ? content.length > 0 : content.length > 0
		if (!hasContent) return undefined
		return { ...message, content }
	}
	if (message.role === "user" || message.role === "developer" || message.role === "system") return message
	return undefined
}

/** @param {any} forkTurns */
function normalizedForkTurns(forkTurns) {
	if (forkTurns === "none" || forkTurns === "all") return forkTurns
	const n = Number(forkTurns)
	return Number.isInteger(n) && n > 0 ? n : "all"
}

/** @param {Array<{ message: any, entryId: string }>} entries @param {string | number} forkTurns */
function limitForkedTurns(entries, forkTurns) {
	if (forkTurns === "all") return entries
	if (forkTurns === "none") return entries.filter((entry) => isProjectContextMessage(entry.message) || entry.message?.role === "system" || entry.message?.role === "developer")
	const userIndices = entries
		.map((entry, index) => entry.message?.role === "user" && !isProjectContextMessage(entry.message) ? index : -1)
		.filter((index) => index >= 0)
	if (userIndices.length <= forkTurns) return entries
	const cut = userIndices[userIndices.length - forkTurns]
	return entries.filter((entry, index) =>
		index >= cut ||
		isProjectContextMessage(entry.message) ||
		entry.message?.role === "system" ||
		entry.message?.role === "developer",
	)
}

/** @param {any} session @param {Array<{ message: any, entryId: string }>} entries */
function applySubSessionForkProjection(session, entries) {
	const subSession = session?.getSessionConfig?.().subSession
	if (!subSession || typeof subSession !== "object") return entries
	const branchEntryId = typeof subSession.branchEntryId === "string" && subSession.branchEntryId ? subSession.branchEntryId : null
	const inheritedEntryIds = new Set(branchEntryId
		? session.getBranch(branchEntryId).map((entry) => entry.id)
		: [])
	const isInherited = (entry) => inheritedEntryIds.has(String(entry.entryId).split("#", 1)[0])
	const projectedInherited = limitForkedTurns(
		entries
			.filter(isInherited)
			.flatMap((entry) => {
				const message = sanitizeForkedMessage(entry.message)
				return message ? [{ ...entry, message }] : []
			}),
		normalizedForkTurns(subSession.forkTurns),
	)
	const inheritedKeys = new Set(entries.filter(isInherited).map((entry) => entry.entryId))
	return [
		...projectedInherited,
		...entries.filter((entry) => !inheritedKeys.has(entry.entryId)),
	]
}

/**
 * @param {any} message
 * @param {{ retainedMaintenanceToolCallIds?: Set<string>, maintenanceKind?: string }} [options]
 */
export function projectMaintenanceMessage(message, options = {}) {
	if (!message?.pinanoAutomated && !message?.pinanoMaintenance) {
		options.maintenanceKind = undefined
		return message
	}
	if (message.role === "user") {
		options.maintenanceKind = typeof message.pinanoMaintenance === "string" ? message.pinanoMaintenance : undefined
		return undefined
	}
	const maintenanceKind = typeof message.pinanoMaintenance === "string" ? message.pinanoMaintenance : options.maintenanceKind
	if (maintenanceKind === SESSION_WORKTREE_LIFECYCLE_MAINTENANCE) return undefined
	const retainedToolCallIds = options.retainedMaintenanceToolCallIds
	if (message.role === "assistant") {
		const toolCalls = Array.isArray(message.content)
			? message.content.filter((block) => block?.type === "toolCall")
			: []
		if (toolCalls.length === 0) return undefined
		for (const block of toolCalls) {
			if (block.id) retainedToolCallIds?.add(block.id)
		}
		const projected = { ...message, content: toolCalls }
		delete projected.pinanoAutomated
		delete projected.pinanoMaintenance
		return projected
	}
	if (message.role === "toolResult" && retainedToolCallIds?.has(message.toolCallId)) {
		const projected = { ...message }
		delete projected.pinanoAutomated
		delete projected.pinanoMaintenance
		return projected
	}
	return undefined
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
	const projection = { retainedMaintenanceToolCallIds }
	const entries = (session?.getLogicalEntries?.(fromId) ?? [])
		.flatMap((entry) => {
			const message = projectMaintenanceMessage(entry.message, projection)
			return message ? [{ ...entry, message: modelCompactionHandoffMessage(message) }] : []
		})
	return pruneBeforeLatestResponsesCompaction(applySubSessionForkProjection(session, entries))
}

/** Build model-visible messages by prefixing a canonical context bundle to
 * the compacted conversation projection.
 * @param {ReadonlyArray<ContextSnapshotFile>} files
 * @param {ReadonlyArray<any>} conversationMessages
 * @param {string} cwd
 * @returns {any[]} */
export function buildModelMessagesWithContextFiles(files, conversationMessages, cwd) {
	const contextMessage = buildContextBundleMessage(contextFilesForModel(files), cwd)
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

/** @param {ReadonlyArray<any>} messages */
export function projectAutomatedMaintenanceMessages(messages) {
	const retainedMaintenanceToolCallIds = new Set()
	const projection = { retainedMaintenanceToolCallIds }
	return messages
		.map((message) => projectMaintenanceMessage(message, projection))
		.filter(Boolean)
}

function stripStaleAutomatedMessages(messages) {
	const last = messages[messages.length - 1]
	if (last?.pinanoAutomated || last?.pinanoMaintenance) return messages
	return projectAutomatedMaintenanceMessages(messages)
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
	return buildContextBundleMessage(contextFilesForModel(activeContextFiles(session)), cwd ?? session?.getMetadata?.().cwd ?? process.cwd())
}
