// On-disk session storage. JSONL: first line is a session header, each
// subsequent line is one SessionEntry. Append-only — branching is encoded
// via `parentId`, never by rewriting earlier entries.

import { randomUUID } from "node:crypto"
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

const HEADER_VERSION = 1

/** @typedef {import("./types.js").SessionEntry} SessionEntry */
/** @typedef {import("./types.js").SessionMetadata} SessionMetadata */

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

export class JsonlSessionStorage {
	#filePath
	#metadata
	#entries
	#byId
	#labels
	#leafId

	constructor(filePath, metadata, entries, leafId) {
		this.#filePath = filePath
		this.#metadata = metadata
		this.#entries = entries
		this.#byId = new Map(entries.map((e) => [e.id, e]))
		this.#labels = buildLabelMap(entries)
		this.#leafId = leafId
	}

	static async create(filePath, options) {
		const resolved = resolve(filePath)
		const metadata = {
			id: options.sessionId,
			createdAt: new Date().toISOString(),
			cwd: options.cwd,
			parentSessionPath: options.parentSessionPath,
		}
		const header = { type: "session", version: HEADER_VERSION, ...metadata }
		await mkdir(dirname(resolved), { recursive: true })
		await writeFile(resolved, `${JSON.stringify(header)}\n`)
		return new JsonlSessionStorage(resolved, metadata, [], null)
	}

	static async open(filePath) {
		const resolved = resolve(filePath)
		const text = await readFile(resolved, "utf-8")
		const lines = text.split("\n").filter((l) => l.trim())
		if (lines.length === 0) throw new Error(`Empty session file: ${resolved}`)
		let header
		try {
			header = JSON.parse(lines[0])
		} catch {
			throw new Error(`First line is not a valid session header: ${resolved}`)
		}
		if (header.type !== "session") throw new Error(`Missing session header in ${resolved}`)

		const metadata = {
			id: header.id,
			createdAt: header.timestamp ?? header.createdAt,
			cwd: header.cwd,
			parentSessionPath: header.parentSession ?? header.parentSessionPath,
		}

		const entries = []
		let leafId = null
		for (const line of lines.slice(1)) {
			try {
				const entry = JSON.parse(line)
				entries.push(entry)
				leafId = entry.id
			} catch {
				// silently skip malformed lines — append-only files can have torn writes
			}
		}
		return new JsonlSessionStorage(resolved, metadata, entries, leafId)
	}

	get filePath() {
		return this.#filePath
	}
	getMetadata() {
		return this.#metadata
	}
	getLeafId() {
		return this.#leafId
	}
	setLeafId(id) {
		if (id !== null && !this.#byId.has(id)) throw new Error(`Entry ${id} not found`)
		this.#leafId = id
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
		return this.#entries.filter((e) => e.type === type)
	}
	getLabel(id) {
		return this.#labels.get(id)
	}

	async appendEntry(entry) {
		await appendFile(this.#filePath, `${JSON.stringify(entry)}\n`)
		this.#entries.push(entry)
		this.#byId.set(entry.id, entry)
		if (entry.type === "label") {
			const trimmed = entry.label?.trim()
			if (trimmed) this.#labels.set(entry.targetId, trimmed)
			else this.#labels.delete(entry.targetId)
		}
		this.#leafId = entry.id
	}

	getPathToRoot(leafId) {
		if (leafId === null) return []
		const path = []
		let cur = this.#byId.get(leafId)
		while (cur) {
			path.unshift(cur)
			cur = cur.parentId ? this.#byId.get(cur.parentId) : undefined
		}
		return path
	}
}
