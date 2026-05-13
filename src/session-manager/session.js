// Stateful wrapper around a session storage. Pinano sessions are a tree of
// entries (parent-pointer adjacency list); a "branch" is the sequence of
// entries from the current leaf to the root.
//
// Forking is implicit: call `moveTo(entryId)` to make `entryId` the leaf,
// then append new entries — they get the previous leaf as parent.

/** @typedef {import("./types.js").SessionEntry} SessionEntry */
/** @typedef {import("../agent-core/types.js").AgentMessage} AgentMessage */

export class Session {
	constructor(storage) {
		this.storage = storage
	}

	getMetadata() {
		return this.storage.getMetadata()
	}

	getLeafId() {
		return this.storage.getLeafId()
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
		const leafId = fromId ?? this.storage.getLeafId()
		return this.storage.getPathToRoot(leafId)
	}

	getMessages(fromId) {
		return this.getBranch(fromId)
			.filter((e) => e.type === "message")
			.map((e) => e.message)
	}

	getSessionName() {
		const infos = this.storage.findEntries("session_info")
		const last = infos[infos.length - 1]
		return last?.name?.trim() || undefined
	}

	async appendMessage(message) {
		const entry = {
			type: "message",
			id: this.storage.createEntryId(),
			parentId: this.storage.getLeafId(),
			timestamp: new Date().toISOString(),
			message,
		}
		await this.storage.appendEntry(entry)
		return entry.id
	}

	async appendLabel(targetId, label) {
		if (!this.storage.getEntry(targetId)) throw new Error(`Entry ${targetId} not found`)
		const entry = {
			type: "label",
			id: this.storage.createEntryId(),
			parentId: this.storage.getLeafId(),
			timestamp: new Date().toISOString(),
			targetId,
			label,
		}
		await this.storage.appendEntry(entry)
		return entry.id
	}

	async appendSessionName(name) {
		const entry = {
			type: "session_info",
			id: this.storage.createEntryId(),
			parentId: this.storage.getLeafId(),
			timestamp: new Date().toISOString(),
			name: name.trim(),
		}
		await this.storage.appendEntry(entry)
		return entry.id
	}

	async appendCustomEntry(customType, data) {
		const entry = {
			type: "custom",
			id: this.storage.createEntryId(),
			parentId: this.storage.getLeafId(),
			timestamp: new Date().toISOString(),
			customType,
			data,
		}
		await this.storage.appendEntry(entry)
		return entry.id
	}

	/**
	 * Move the leaf to `entryId` (or `null` for the root). Subsequent appends
	 * branch off from there.
	 */
	moveTo(entryId) {
		this.storage.setLeafId(entryId)
	}
}
