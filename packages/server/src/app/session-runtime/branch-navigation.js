import { BASH_SHORTCUT_CUSTOM_TYPE, bashShortcutSummaryForEntry } from "../../session-manager/bash-shortcut-entry.js"
import { fileCheckpointsForRestore } from "../file-checkpoints.js"
import { isProjectContextMessage } from "../project-context.js"
import { SESSION_CUSTOM_TYPE_FILE_RESTORE, isBranchSwitchCustomType, isRewindCustomType } from "../session-custom-types.js"
import { SESSION_CUSTOM_TYPE_PROPERTIES, isHumanUserEntry } from "../session-properties.js"
import { textFromContent } from "./transcript-projection.js"

/** @param {any} entry */
export function entryMessageText(entry) {
	return textFromContent(entry?.message?.content).trim()
}

/** @param {any} entry */
function entrySummary(entry) {
	if (entry.type !== "message") {
		if (entry.customType === "compaction") return "compaction marker"
		if (entry.customType === BASH_SHORTCUT_CUSTOM_TYPE) return bashShortcutSummaryForEntry(entry)
		if (isRewindCustomType(entry.customType)) return `rewind: ${entry.data?.text || entry.data?.targetEntryId || entry.id}`
		if (isBranchSwitchCustomType(entry.customType)) return `branch switch: ${entry.data?.targetEntryId || entry.id}`
		if (entry.customType === SESSION_CUSTOM_TYPE_FILE_RESTORE) return `file restore: ${(entry.data?.restored ?? []).length} file(s)`
		if (entry.customType === SESSION_CUSTOM_TYPE_PROPERTIES) return "session properties"
		return entry.type
	}
	const message = entry.message
	if (message.role === "user") return `user: ${entryMessageText(entry).slice(0, 80)}`
	if (message.role === "assistant") return `assistant: ${(textFromContent(message.content) || "(tool call)").slice(0, 80)}`
	if (message.role === "toolResult") return `tool: ${message.toolName || "result"}`
	return message.role || "message"
}

/** @param {import("../../session-manager/index.js").Session} session */
export function buildRewindTargets(session) {
	const entries = /** @type {any[]} */ (session.getEntries())
	const userEntries = entries.filter((e) => isHumanUserEntry(e) && !isProjectContextMessage(e.message))
	const userIds = new Set(userEntries.map((e) => e.id))
	const entryById = new Map(entries.map((e) => [e.id, e]))
	const leafIds = new Set(buildBranchTipItems(session).map((leaf) => leaf.id))
	const userParentOf = (id) => {
		let cur = entryById.get(id)?.parentId ?? null
		while (cur !== null) {
			if (userIds.has(cur)) return cur
			cur = entryById.get(cur)?.parentId ?? null
		}
		return null
	}
	const activePath = new Set()
	let cur = session.getLeafId()
	while (cur) {
		if (userIds.has(cur)) activePath.add(cur)
		cur = entryById.get(cur)?.parentId ?? null
	}
	const userTargets = userEntries.map((e) => ({
		kind: "message",
		id: e.id,
		parentId: userParentOf(e.id),
		text: entryMessageText(e) || entrySummary(e),
		onActivePath: activePath.has(e.id),
		isLeaf: leafIds.has(e.id),
		active: e.id === session.getLeafId(),
		hasFileCheckpoints: fileCheckpointsForRestore(session, e.id).length > 0,
	}))
	const userTargetIds = new Set(userTargets.map((target) => target.id))
	const leafTargets = entries
		.filter((e) => leafIds.has(e.id) && !userTargetIds.has(e.id))
		.map((e) => {
			const displayEntry = isBranchSwitchCustomType(e.customType)
				? entryById.get(e.data?.targetEntryId) ?? e
				: e
			return {
				kind: "leaf",
				id: e.id,
				parentId: userParentOf(e.id),
				text: `tip: ${entrySummary(displayEntry)}`,
				onActivePath: false,
				isLeaf: true,
				active: e.id === session.getLeafId(),
				hasFileCheckpoints: false,
			}
		})
		.filter((target) => target.parentId !== null)
	return [...userTargets, ...leafTargets]
}

/** @param {import("../../session-manager/index.js").Session} session */
export function buildBranchTipItems(session) {
	const entries = /** @type {any[]} */ (session.getEntries())
	/** @type {Map<string | null, string[]>} */
	const childrenOf = new Map()
	for (const e of entries) {
		const parentId = e.parentId ?? null
		const arr = childrenOf.get(parentId) ?? []
		arr.push(e.id)
		childrenOf.set(parentId, arr)
	}
	return entries
		.filter((e) => !childrenOf.get(e.id))
		.map((e) => ({
			id: e.id,
			label: e.id.slice(0, 8),
			description: entrySummary(e),
			active: e.id === session.getLeafId(),
		}))
}
