// In-process session tree/cache backed by the database-independent async persistence contract.

import { randomUUID } from "node:crypto"

function shortId(byId) {
	for (let i = 0; i < 200; i++) {
		const id = randomUUID().slice(0, 8)
		if (!byId.has(id)) return id
	}
	return randomUUID()
}

function buildLabelMap(entries) {
	const labels = new Map()
	for (const entry of entries) {
		if (entry.type !== "label") continue
		const trimmed = entry.label?.trim()
		if (trimmed) labels.set(entry.targetId, trimmed)
		else labels.delete(entry.targetId)
	}
	return labels
}

export class PersistenceSessionStorage {
	#persistence
	#metadata
	#entries
	#byId
	#globalById
	#labels
	#leafId
	#mutationVersion

	constructor(persistence, snapshot) {
		this.asyncMutations = true
		this.#persistence = persistence
		this.#metadata = snapshot.metadata
		this.#entries = snapshot.entries
		this.#byId = new Map(snapshot.entries.map((entry) => [entry.id, entry]))
		this.#globalById = new Map(snapshot.entryGlobalIds)
		this.#labels = buildLabelMap(snapshot.entries)
		this.#leafId = snapshot.leafId
		this.#mutationVersion = snapshot.mutationVersion
	}

	getMetadata() {
		return this.#metadata
	}

	getLeafId() {
		return this.#leafId
	}

	getMutationVersion() {
		return this.#mutationVersion
	}

	async setLeafId(id, options = {}) {
		if (id !== null && !this.#byId.has(id)) throw new Error(`Entry ${id} not found`)
		const result = await this.#persistence.setSessionLeaf({
			sessionId: this.#metadata.id,
			leafId: id,
			expectedMutationVersion: this.#mutationVersion,
			ownerRunId: typeof options.runId === "string" && options.runId ? options.runId : null,
		})
		this.#leafId = id
		this.#mutationVersion = result.mutationVersion
	}

	createEntryId() {
		return shortId(this.#byId)
	}

	getEntry(id) {
		return this.#byId.get(id)
	}

	getEntries() {
		return [...this.#entries]
	}

	findEntries(type) {
		return this.#entries.filter((entry) => entry.type === type)
	}

	getLabel(id) {
		return this.#labels.get(id)
	}

	getGlobalEntryId(id) {
		return this.#globalById.get(id)
	}

	getBranchGlobalIds(fromId) {
		return this.getPathToRoot(fromId ?? this.#leafId).map((entry) => this.#globalById.get(entry.id)).filter(Boolean)
	}

	async appendEntry(entry, options = {}) {
		if (entry.parentId && !this.#byId.has(entry.parentId)) throw new Error(`Parent entry ${entry.parentId} not found`)
		const targetGlobalId = entry.type === "label" ? this.#globalById.get(entry.targetId) : undefined
		if (entry.type === "label" && !targetGlobalId) throw new Error(`Entry ${entry.targetId} not found`)
		const result = await this.#persistence.appendSessionEntry({
			sessionId: this.#metadata.id,
			entry,
			expectedMutationVersion: this.#mutationVersion,
			ownerRunId: typeof options.runId === "string" && options.runId ? options.runId : null,
			targetGlobalId,
		})
		this.#entries.push(entry)
		this.#byId.set(entry.id, entry)
		this.#globalById.set(entry.id, result.globalId)
		if (entry.type === "label") {
			const trimmed = entry.label?.trim()
			if (trimmed) this.#labels.set(entry.targetId, trimmed)
			else this.#labels.delete(entry.targetId)
		}
		this.#leafId = entry.id
		this.#mutationVersion = result.mutationVersion
	}

	getPathToRoot(leafId) {
		if (leafId === null) return []
		const path = []
		let current = this.#byId.get(leafId)
		while (current) {
			path.unshift(current)
			current = current.parentId ? this.#byId.get(current.parentId) : undefined
		}
		return path
	}
}
