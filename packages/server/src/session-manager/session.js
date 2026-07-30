// Stateful wrapper around a session storage. Cerex sessions view a tree of
// immutable conversation entries (parent-pointer adjacency list); a "branch" is
// the sequence of entries from the current leaf to the root.
//
// Rewinding within one session is implicit: call `moveTo(entryId)` to make
// `entryId` the leaf, then append new entries — they get the previous leaf as
// parent. Separate sessions can also share the same immutable prefix in the
// SQLite-backed global conversation DAG.

import { createHash } from "node:crypto"
import { dirname } from "node:path"

import {
	BASH_SHORTCUT_CUSTOM_TYPE,
	bashShortcutDisplayMessageForEntry,
	bashShortcutModelMessageForEntry,
} from "./bash-shortcut-entry.js"
import { contextLoadDisplayMessage } from "./context-display.js"
import { contextFileIdentityPath } from "./context-identity.js"
import { PLAN_UPDATE_CUSTOM_TYPE, planUpdateDisplayMessageForEntry } from "./plan-update-entry.js"
import { PROJECT_LOCATION_CUSTOM_TYPE, applyProjectLocationToConfig, projectLocationChangeFromEntry, projectLocationDisplayMessageForEntry, projectLocationModelMessageForEntry } from "./project-location-entry.js"

/** @typedef {import("./types.js").SessionEntry} SessionEntry */
/** @typedef {import("../agent-core/types.js").AgentMessage} AgentMessage */

const SESSION_GLOBAL_CONFIG_CUSTOM_TYPE = "session_global_config"

function assistantToolCallOrder(message) {
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return undefined
	const order = new Map()
	for (const block of message.content) {
		if (block?.type === "toolCall" && block.id && !order.has(block.id)) order.set(block.id, order.size)
	}
	return order.size > 0 ? order : undefined
}

function normalizeContextFile(file) {
	const content = file?.content ?? ""
	return {
		path: file?.path ?? "",
		scopeDir: file?.scopeDir ?? dirname(file?.path ?? "."),
		identityPath: file?.identityPath ?? contextFileIdentityPath(file?.path ?? ""),
		content,
		hash: file?.hash ?? createHash("sha256").update(content).digest("hex"),
	}
}

function replacementMessagesForCompactionEntry(entry) {
	const data = entry.data ?? {}
	const context = data.replacementContext
	if ((context?.kind === "messages" || context?.kind === "pinano-messages") && Array.isArray(context.messages)) return context.messages
	return []
}

function displayMessageForCompactionEntry(entry) {
	const data = entry.data ?? {}
	return data.displayMessage
}

export function compactionReplacementEntryId(entryId, replacementMessages, index) {
	if (replacementMessages.length === 1) return entryId
	const markerIndex = replacementMessages.reduce(
		(latest, message, i) => (message?.compaction === true || message?.compactionSummary === true) ? i : latest,
		-1,
	)
	const durableIndex = markerIndex >= 0 ? markerIndex : replacementMessages.length - 1
	return index === durableIndex ? entryId : `${entryId}#${index}`
}

function findLastEntryIndex(entries, entryId) {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].entryId === entryId) return i
	}
	return -1
}

function reorderToolResultsAfterAssistant(logical) {
	const out = []
	for (let i = 0; i < logical.length; i++) {
		const entry = logical[i]
		out.push(entry)
		const order = assistantToolCallOrder(entry.message)
		if (!order) continue
		const start = i + 1
		let end = start
		while (end < logical.length && logical[end].message?.role === "toolResult" && order.has(logical[end].message.toolCallId)) end++
		if (end === start) continue
		const ordered = logical.slice(start, end).sort((a, b) => order.get(a.message.toolCallId) - order.get(b.message.toolCallId))
		out.push(...ordered)
		i = end - 1
	}
	return out
}

export class Session {
	constructor(storage) {
		this.storage = storage
		this.mutationRunId = null
		this.mutationQueue = Promise.resolve()
	}

	getMetadata() {
		return this.storage.getMetadata()
	}

	getLeafId() {
		return this.storage.getLeafId()
	}

	getMutationVersion() {
		return this.storage.getMutationVersion?.() ?? 0
	}

	setMutationRunId(runId) {
		this.mutationRunId = typeof runId === "string" && runId ? runId : null
	}

	clearMutationRunId(runId) {
		if (!runId || this.mutationRunId === runId) this.mutationRunId = null
	}

	mutationOptions(options = {}) {
		return { ...options, runId: options.runId ?? this.mutationRunId ?? undefined }
	}

	mutate(operation) {
		if (this.storage.asyncMutations !== true) return operation()
		const mutation = this.mutationQueue.then(operation)
		this.mutationQueue = mutation.then(() => undefined, () => undefined)
		return mutation
	}

	getEntry(id) {
		return this.storage.getEntry(id)
	}

	getEntries() {
		return this.storage.getEntries()
	}

	getLabel(id) {
		return this.storage.getLabel(id)
	}

	getBranch(fromId) {
		const leafId = fromId === undefined ? this.storage.getLeafId() : fromId
		return this.storage.getPathToRoot(leafId)
	}

	getMessages(fromId) {
		return this.getLogicalEntries(fromId).map((e) => e.message)
	}

	/** Full user-facing branch projection. Unlike getLogicalEntries(), this keeps
	 * all original messages visible and inserts compaction markers at their
	 * semantic cut boundary. Use this for transcripts; use getLogicalEntries()
	 * for model context.
	 * @param {string} [fromId]
	 * @returns {Array<{ message: AgentMessage, entryId: string, sequence: number }>} */
	getDisplayEntries(fromId) {
		const sequenceByEntryId = new Map(this.getEntries().map((entry, index) => [entry.id, index + 1]))
		return this.projectEntries(fromId, { applyCompaction: false }).map((entry) => ({
			...entry,
			sequence: sequenceByEntryId.get(entry.entryId),
		}))
	}

	/** Walk the branch root→leaf, applying durable custom entries as patches
	 * against the linear message history. Returns the resulting logical message
	 * list paired with the entry IDs that produced each message. Normal messages
	 * keep their real entry ID; compaction replacements keep the compaction entry
	 * ID on the durable model-facing summary/display marker (or final fallback
	 * message) and synthetic IDs for hidden retained mementos. The entry IDs let
	 * callers build a Message→EntryId map without re-walking the branch.
	 *
	 * Each compaction custom entry carries:
	 *   - `cutEntryId`: the entry ID at the upper end of the elided range
	 *     (inclusive). Replaces every logical message from start-of-branch up to
	 *     and including this entry with the stored replacement context (usually
	 *     hidden retained user mementos plus a model-facing compaction summary).
	 *     `cutEntryId` may itself refer to a previous compaction entry — that's
	 *     how nested compactions compose.
	 *   - `replacementContext`: the model-facing replacement messages.
	 *   - `displayMessage`: the synthetic assistant marker to show in transcripts
	 *     (carries summary text, removedCount/mementoCount/keptCount/tokensBefore
	 *     metadata, the summary-call usage/cost, etc). `keptCount` is
	 *     provider-native checkpoints preserved verbatim; `mementoCount` is
	 *     retained real user messages.
	 *
	 * If a compaction entry's `cutEntryId` isn't found in the current logical list
	 * (corrupted state, manual edit), the patch is skipped defensively — replay
	 * continues with the un-elided view.
	 * @param {string} [fromId]
	 * @returns {Array<{ message: AgentMessage, entryId: string }>} */
	getLogicalEntries(fromId) {
		return this.projectEntries(fromId, { applyCompaction: true })
	}

	/**
	 * @param {string | undefined} fromId
	 * @param {{ applyCompaction: boolean }} options
	 * @returns {Array<{ message: AgentMessage, entryId: string }>}
	 */
	projectEntries(fromId, options) {
		const branch = this.getBranch(fromId)
		/** @type {Array<{ message: any, entryId: string }>} */
		let projected = []
		for (const entry of branch) {
			if (entry.type === "message") {
				projected.push({ message: entry.message, entryId: entry.id })
			} else if (entry.type === "custom" && entry.customType === BASH_SHORTCUT_CUSTOM_TYPE) {
				const message = options.applyCompaction
					? bashShortcutModelMessageForEntry(entry)
					: bashShortcutDisplayMessageForEntry(entry)
				if (message) projected.push({ message, entryId: entry.id })
			} else if (entry.type === "custom" && entry.customType === PLAN_UPDATE_CUSTOM_TYPE) {
				if (!options.applyCompaction) {
					const message = planUpdateDisplayMessageForEntry(entry)
					if (message) projected.push({ message, entryId: entry.id })
				}
			} else if (entry.type === "custom" && entry.customType === PROJECT_LOCATION_CUSTOM_TYPE) {
				const message = options.applyCompaction
					? projectLocationModelMessageForEntry(entry)
					: projectLocationDisplayMessageForEntry(entry)
				if (message) projected.push({ message, entryId: entry.id })
			} else if (entry.type === "custom" && entry.customType === "compaction") {
				const data = /** @type {any} */ (entry.data) ?? {}
				const cutEntryId = data.cutEntryId
				const replacementMessages = replacementMessagesForCompactionEntry(entry)
				const displayMessage = displayMessageForCompactionEntry(entry)
				if (!cutEntryId || !displayMessage || (options.applyCompaction && replacementMessages.length === 0)) continue
				const cutIdx = options.applyCompaction
					? findLastEntryIndex(projected, cutEntryId)
					: projected.findIndex((e) => e.entryId === cutEntryId)
				if (cutIdx < 0) continue
				if (options.applyCompaction) {
					projected = [
						...replacementMessages.map((message, i) => ({
							message,
							entryId: compactionReplacementEntryId(entry.id, replacementMessages, i),
						})),
						...projected.slice(cutIdx + 1),
					]
				} else {
					const markerIdx = cutIdx + 1
					projected.splice(markerIdx, 0, { message: displayMessage, entryId: entry.id })
				}
			} else if (entry.type === "context") {
				if (!options.applyCompaction) {
					const message = contextLoadDisplayMessage({ contextLoad: entry.contextLoad, timestamp: entry.timestamp })
					if (message) projected.push({ message, entryId: entry.id })
				}
			}
		}
		return reorderToolResultsAfterAssistant(projected)
	}

	getSessionConfig() {
		const branchConfig = this.getBranch().reduce((config, entry) => {
			if (entry.type === "custom" && entry.customType === "config") return { ...config, ...(entry.data ?? {}) }
			return applyProjectLocationToConfig(config, projectLocationChangeFromEntry(entry))
		}, {})
		return { ...branchConfig, ...this.getGlobalSessionConfig() }
	}

	getGlobalSessionConfig() {
		// Global patches are still immutable session events, but they are reduced across every branch so moving the active leaf cannot roll them back.
		return this.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === SESSION_GLOBAL_CONFIG_CUSTOM_TYPE)
			.reduce((config, entry) => ({ ...config, ...(entry.data ?? {}) }), {})
	}

	getContextLoads(fromId) {
		return this.getBranch(fromId)
			.map((entry) => entry.contextLoad ? { entryId: entry.id, ...entry.contextLoad } : null)
			.filter(Boolean)
	}

	appendContextLoad(load, options = {}) {
		const mutationOptions = this.mutationOptions(options)
		return this.mutate(async () => {
			const entry = {
				type: "context",
				id: this.storage.createEntryId(),
				parentId: this.storage.getLeafId(),
				timestamp: new Date().toISOString(),
				contextLoad: {
					source: load.source ?? "unknown",
					...(load.cwd ? { cwd: load.cwd } : {}),
					loadedAt: load.loadedAt ?? new Date().toISOString(),
					disabled: load.disabled === true,
					files: (load.files ?? []).map(normalizeContextFile),
				},
			}
			await this.storage.appendEntry(entry, mutationOptions)
			return entry.id
		})
	}

	async appendConfigPatch(data, options = {}) {
		return this.appendCustomEntry("config", data, options)
	}

	async appendGlobalConfigPatch(data, options = {}) {
		return this.appendCustomEntry(SESSION_GLOBAL_CONFIG_CUSTOM_TYPE, data, options)
	}

	appendMessage(message, options = {}) {
		const mutationOptions = this.mutationOptions(options)
		return this.mutate(async () => {
			const entry = {
				type: "message",
				id: this.storage.createEntryId(),
				parentId: this.storage.getLeafId(),
				timestamp: new Date().toISOString(),
				message,
			}
			await this.storage.appendEntry(entry, mutationOptions)
			return entry.id
		})
	}

	appendLabel(targetId, label, options = {}) {
		const mutationOptions = this.mutationOptions(options)
		return this.mutate(async () => {
			if (!this.storage.getEntry(targetId)) throw new Error(`Entry ${targetId} not found`)
			const entry = {
				type: "label",
				id: this.storage.createEntryId(),
				parentId: this.storage.getLeafId(),
				timestamp: new Date().toISOString(),
				targetId,
				label,
			}
			await this.storage.appendEntry(entry, mutationOptions)
			return entry.id
		})
	}

	appendCustomEntry(customType, data, options = {}) {
		const mutationOptions = this.mutationOptions(options)
		return this.mutate(async () => {
			const entry = {
				type: "custom",
				id: this.storage.createEntryId(),
				parentId: this.storage.getLeafId(),
				timestamp: new Date().toISOString(),
				customType,
				data,
			}
			await this.storage.appendEntry(entry, mutationOptions)
			return entry.id
		})
	}

	/**
	 * Move the leaf to `entryId` (or `null` for the root). Subsequent appends
	 * branch off from there.
	 */
	moveTo(entryId, options = {}) {
		const mutationOptions = this.mutationOptions(options)
		return this.mutate(() => this.storage.setLeafId(entryId, mutationOptions))
	}
}
