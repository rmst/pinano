// In-memory session storage. Useful for tests and ephemeral sessions where
// the user has not opted into on-disk persistence yet.

import { randomUUID } from "node:crypto"

function shortId(byId) {
	for (let i = 0; i < 200; i++) {
		const id = randomUUID().slice(0, 8)
		if (!byId.has(id)) return id
	}
	return randomUUID()
}

export class MemorySessionStorage {
	constructor(metadata) {
		this.metadata = metadata
		this.entries = []
		this.byId = new Map()
		this.labels = new Map()
		this.leafId = null
	}

	getMetadata() {
		return this.metadata
	}
	getLeafId() {
		return this.leafId
	}
	setLeafId(id) {
		if (id !== null && !this.byId.has(id)) throw new Error(`Entry ${id} not found`)
		this.leafId = id
	}
	createEntryId() {
		return shortId(this.byId)
	}
	getEntry(id) {
		return this.byId.get(id)
	}
	getEntries() {
		return [...this.entries]
	}
	findEntries(type) {
		return this.entries.filter((e) => e.type === type)
	}
	getLabel(id) {
		return this.labels.get(id)
	}
	async appendEntry(entry) {
		this.entries.push(entry)
		this.byId.set(entry.id, entry)
		if (entry.type === "label") {
			const trimmed = entry.label?.trim()
			if (trimmed) this.labels.set(entry.targetId, trimmed)
			else this.labels.delete(entry.targetId)
		}
		this.leafId = entry.id
	}
	getPathToRoot(leafId) {
		if (leafId === null) return []
		const path = []
		let cur = this.byId.get(leafId)
		while (cur) {
			path.unshift(cur)
			cur = cur.parentId ? this.byId.get(cur.parentId) : undefined
		}
		return path
	}
}
