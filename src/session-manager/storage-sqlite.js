import { randomUUID } from "node:crypto"

/** @typedef {import("./types.js").SessionEntry} SessionEntry */
/** @typedef {import("./types.js").SessionMetadata} SessionMetadata */

const KNOWN_MESSAGE_KEYS = {
	user: new Set(["role", "content", "timestamp"]),
	assistant: new Set(["role", "content", "provider", "model", "auth", "responseModel", "responseId", "modelRequestId", "usage", "stopReason", "errorMessage", "timestamp"]),
	toolResult: new Set(["role", "toolCallId", "toolName", "content", "isError", "timestamp", "details"]),
}

function shortId(byId) {
	for (let i = 0; i < 200; i++) {
		const id = randomUUID().slice(0, 8)
		if (!byId.has(id)) return id
	}
	return randomUUID()
}

function parseJson(text, fallback = undefined) {
	if (text === null || text === undefined) return fallback
	try {
		return JSON.parse(String(text))
	} catch {
		return fallback
	}
}

function jsonOrNull(value) {
	return value === undefined ? null : JSON.stringify(value)
}

function numberOrNull(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : null
}

function boolToInt(value) {
	return value ? 1 : 0
}

function intToBool(value) {
	return value === 1 || value === true
}

function extraMessageFields(message) {
	const known = KNOWN_MESSAGE_KEYS[message?.role] ?? new Set(["role", "content", "timestamp"])
	const extra = {}
	for (const [key, value] of Object.entries(message ?? {})) {
		if (!known.has(key)) extra[key] = value
	}
	return Object.keys(extra).length > 0 ? extra : undefined
}

function contentFormatFor(message) {
	return typeof message?.content === "string" ? "string" : Array.isArray(message?.content) ? "blocks" : "none"
}

function contentBlocksFor(message) {
	if (typeof message?.content === "string") return [{ type: "text", text: message.content }]
	if (Array.isArray(message?.content)) return message.content
	return []
}

function serializeBlock(block) {
	const type = typeof block?.type === "string" ? block.type : "unknown"
	if (type === "text") {
		return {
			type,
			text: block.text ?? "",
			textSignature: block.textSignature ?? null,
		}
	}
	if (type === "thinking") {
		return {
			type,
			thinking: block.thinking ?? "",
			thinkingSignature: block.thinkingSignature ?? null,
			redacted: block.redacted ? 1 : 0,
		}
	}
	if (type === "image") {
		return {
			type,
			imageData: block.data ?? "",
			imageMimeType: block.mimeType ?? null,
			imageDetail: block.detail ?? null,
			imageWidthPx: numberOrNull(block.widthPx),
			imageHeightPx: numberOrNull(block.heightPx),
		}
	}
	if (type === "toolCall") {
		return {
			type,
			toolCallId: block.id ?? "",
			toolName: block.name ?? "",
			toolArgsJson: block.input === undefined ? jsonOrNull(block.arguments ?? {}) : null,
			toolInput: block.input ?? null,
		}
	}
	return { type, payloadJson: jsonOrNull(block) }
}

function deserializeBlock(row) {
	if (row.type === "text") {
		return {
			type: "text",
			text: row.text ?? "",
			...(row.textSignature ? { textSignature: row.textSignature } : {}),
		}
	}
	if (row.type === "thinking") {
		return {
			type: "thinking",
			thinking: row.thinking ?? "",
			...(row.thinkingSignature ? { thinkingSignature: row.thinkingSignature } : {}),
			...(row.redacted ? { redacted: true } : {}),
		}
	}
	if (row.type === "image") {
		return {
			type: "image",
			data: row.imageData ?? "",
			mimeType: row.imageMimeType ?? "application/octet-stream",
			...(row.imageDetail ? { detail: row.imageDetail } : {}),
			...(row.imageWidthPx !== null && row.imageWidthPx !== undefined ? { widthPx: row.imageWidthPx } : {}),
			...(row.imageHeightPx !== null && row.imageHeightPx !== undefined ? { heightPx: row.imageHeightPx } : {}),
		}
	}
	if (row.type === "toolCall") {
		return {
			type: "toolCall",
			id: row.toolCallId ?? "",
			name: row.toolName ?? "",
			...(typeof row.toolInput === "string"
				? { input: row.toolInput }
				: { arguments: parseJson(row.toolArgsJson, {}) }),
		}
	}
	return parseJson(row.payloadJson, { type: row.type })
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

function entryKind(entry) {
	if (entry.type === "message") return "message"
	if (entry.type === "label") return "label"
	if (entry.type === "custom") return "custom"
	if (entry.type === "context") return "context"
	throw new Error(`Unsupported session entry type: ${entry.type}`)
}

function storageMutationError(message, code) {
	const err = new Error(message)
	err.code = code
	return err
}

function mutationOwnerRunId(options) {
	return typeof options?.runId === "string" && options.runId ? options.runId : null
}

function sessionMutationRow(db, sessionId) {
	return db.prepare(`
		SELECT mutation_version AS mutationVersion, mutation_run_id AS mutationRunId
		FROM sessions
		WHERE id = ? AND deleted_at IS NULL
	`).get(sessionId)
}

function assertSessionMutationAllowed(db, sessionId, expectedVersion, ownerRunId) {
	const row = sessionMutationRow(db, sessionId)
	if (!row) throw storageMutationError(`Session not found: ${sessionId}`, "PINANO_SESSION_NOT_FOUND")
	const actualVersion = Number(row.mutationVersion ?? 0)
	if (actualVersion !== expectedVersion) {
		throw storageMutationError(`Session ${sessionId} changed in the database; reopen it before mutating.`, "PINANO_SESSION_STALE")
	}
	const actualOwnerRunId = row.mutationRunId ?? null
	if (actualOwnerRunId !== ownerRunId) {
		throw storageMutationError(
			actualOwnerRunId
				? `Session ${sessionId} is being mutated by another run.`
				: `Run ${ownerRunId} does not own session ${sessionId}.`,
			"PINANO_SESSION_MUTATION_OWNER_MISMATCH",
		)
	}
}

function nextSessionSeq(db, sessionId) {
	const row = db.prepare("SELECT COALESCE(MAX(seq) + 1, 0) AS seq FROM session_entry_refs WHERE session_id = ?").get(sessionId)
	return Number(row?.seq ?? 0)
}

export class SqliteSessionStorage {
	#db
	#metadata
	#entries
	#byId
	#globalById
	#labels
	#leafId
	#mutationVersion

	constructor(db, metadata, entries, entryGlobalIds, leafId, mutationVersion) {
		this.#db = db
		this.#metadata = metadata
		this.#entries = entries
		this.#byId = new Map(entries.map((e) => [e.id, e]))
		this.#globalById = entryGlobalIds
		this.#labels = buildLabelMap(entries)
		this.#leafId = leafId
		this.#mutationVersion = mutationVersion
	}

	static create(db, options) {
		const createdAt = options.createdAt ?? new Date().toISOString()
		db.prepare(`
			INSERT INTO sessions (id, cwd, name, created_at, updated_at, deleted_at, active_leaf_entry_id, active_leaf_global_id)
			VALUES (?, ?, NULL, ?, ?, NULL, NULL, NULL)
			ON CONFLICT(id) DO UPDATE SET
				cwd = excluded.cwd,
				created_at = COALESCE(sessions.created_at, excluded.created_at),
				updated_at = excluded.updated_at,
				deleted_at = NULL,
				active_leaf_entry_id = COALESCE(sessions.active_leaf_entry_id, excluded.active_leaf_entry_id),
				active_leaf_global_id = COALESCE(sessions.active_leaf_global_id, excluded.active_leaf_global_id)
		`).run(options.sessionId, options.cwd, createdAt, options.updatedAt ?? createdAt)
		const row = db.prepare("SELECT mutation_version AS mutationVersion FROM sessions WHERE id = ?").get(options.sessionId)
		return new SqliteSessionStorage(db, {
			id: options.sessionId,
			createdAt,
			cwd: options.cwd,
		}, [], new Map(), null, Number(row?.mutationVersion ?? 0))
	}

	static branchFrom(db, sourceSessionId, options = {}) {
		const createdAt = options.createdAt ?? new Date().toISOString()
		const targetSessionId = options.sessionId ?? randomUUID()
		const source = db.prepare(`
			SELECT id, cwd, active_leaf_entry_id AS activeLeafEntryId, active_leaf_global_id AS activeLeafGlobalId
			FROM sessions
			WHERE id = ? AND deleted_at IS NULL
		`).get(sourceSessionId)
		if (!source) throw new Error(`Session not found: ${sourceSessionId}`)
		const branch = source.activeLeafGlobalId || source.activeLeafEntryId
			? db.prepare(`
				WITH RECURSIVE
					leaf(global_id) AS (
						SELECT COALESCE(
							?,
							(
								SELECT ser.global_id
								FROM session_entry_refs ser
								JOIN conversation_entries ce ON ce.global_id = ser.global_id
								WHERE ser.session_id = ? AND ce.id = ?
								LIMIT 1
							)
						)
					),
					branch(global_id, parent_global_id, depth) AS (
						SELECT ce.global_id, ce.parent_global_id, 0
						FROM leaf
						JOIN conversation_entries ce ON ce.global_id = leaf.global_id
						UNION ALL
						SELECT parent.global_id, parent.parent_global_id, branch.depth + 1
						FROM branch
						JOIN conversation_entries parent ON parent.global_id = branch.parent_global_id
					)
				SELECT branch.global_id AS globalId, ce.id, branch.depth
				FROM branch
				JOIN conversation_entries ce ON ce.global_id = branch.global_id
				ORDER BY branch.depth DESC
			`).all(source.activeLeafGlobalId ?? null, sourceSessionId, source.activeLeafEntryId ?? null)
			: []
		const activeLeaf = branch.at(-1)
		db.exec("BEGIN IMMEDIATE")
		try {
			db.prepare(`
				INSERT INTO sessions (
					id,
					cwd,
					name,
					created_at,
					updated_at,
					deleted_at,
					active_leaf_entry_id,
					active_leaf_global_id,
					branched_from_session_id,
					branched_from_entry_id,
					branched_from_entry_global_id,
					branched_at
				)
				VALUES (?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
			`).run(
				targetSessionId,
				options.cwd ?? source.cwd,
				createdAt,
				createdAt,
				activeLeaf?.id ?? source.activeLeafEntryId ?? null,
				activeLeaf?.globalId ?? source.activeLeafGlobalId ?? null,
				sourceSessionId,
				activeLeaf?.id ?? source.activeLeafEntryId ?? null,
				activeLeaf?.globalId ?? source.activeLeafGlobalId ?? null,
				createdAt,
			)
			const insertRef = db.prepare("INSERT INTO session_entry_refs (session_id, global_id, seq) VALUES (?, ?, ?)")
			branch.forEach((entry, seq) => insertRef.run(targetSessionId, entry.globalId, seq))
			db.exec("COMMIT")
		} catch (err) {
			db.exec("ROLLBACK")
			throw err
		}
		return SqliteSessionStorage.open(db, targetSessionId)
	}

	static open(db, sessionId) {
		const row = db.prepare(`
			SELECT
				id,
				cwd,
				created_at AS createdAt,
				active_leaf_entry_id AS activeLeafEntryId,
				active_leaf_global_id AS activeLeafGlobalId,
				mutation_version AS mutationVersion
			FROM sessions
			WHERE id = ? AND deleted_at IS NULL
		`).get(sessionId)
		if (!row) throw new Error(`Session not found: ${sessionId}`)
		const loaded = loadEntries(db, sessionId)
		const { entries, entryGlobalIds } = loaded
		const last = db.prepare(`
			SELECT ce.id, ser.seq
			FROM session_entry_refs ser
			JOIN conversation_entries ce ON ce.global_id = ser.global_id
			WHERE ser.session_id = ?
			ORDER BY ser.seq DESC
			LIMIT 1
		`).get(sessionId)
		const entryIdByGlobalId = new Map([...entryGlobalIds].map(([id, globalId]) => [globalId, id]))
		let activeLeaf = last?.id ?? null
		if (row.activeLeafEntryId && entries.some((entry) => entry.id === row.activeLeafEntryId)) {
			activeLeaf = row.activeLeafEntryId
		}
		if (row.activeLeafGlobalId && entryIdByGlobalId.has(row.activeLeafGlobalId)) {
			activeLeaf = entryIdByGlobalId.get(row.activeLeafGlobalId)
		}
		return new SqliteSessionStorage(db, {
			id: row.id,
			createdAt: row.createdAt,
			cwd: row.cwd,
		}, entries, entryGlobalIds, activeLeaf, Number(row.mutationVersion ?? 0))
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
	setLeafId(id, options = {}) {
		if (id !== null && !this.#byId.has(id)) throw new Error(`Entry ${id} not found`)
		const globalId = id === null ? null : this.#globalById.get(id)
		const ownerRunId = mutationOwnerRunId(options)
		this.#db.exec("BEGIN IMMEDIATE")
		try {
			assertSessionMutationAllowed(this.#db, this.#metadata.id, this.#mutationVersion, ownerRunId)
			this.#db.prepare(`
				UPDATE sessions
				SET active_leaf_entry_id = ?,
					active_leaf_global_id = ?,
					mutation_version = mutation_version + 1
				WHERE id = ? AND deleted_at IS NULL
			`).run(id, globalId ?? null, this.#metadata.id)
			this.#db.exec("COMMIT")
		} catch (err) {
			this.#db.exec("ROLLBACK")
			throw err
		}
		this.#leafId = id
		this.#mutationVersion += 1
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
	getGlobalEntryId(id) {
		return this.#globalById.get(id)
	}
	getBranchGlobalIds(fromId) {
		return this.getPathToRoot(fromId ?? this.#leafId).map((entry) => this.#globalById.get(entry.id)).filter(Boolean)
	}

	async appendEntry(entry, options = {}) {
		const globalId = randomUUID()
		const parentGlobalId = entry.parentId ? this.#globalById.get(entry.parentId) : null
		if (entry.parentId && !parentGlobalId) throw new Error(`Parent entry ${entry.parentId} not found`)
		const targetGlobalId = entry.type === "label" ? this.#globalById.get(entry.targetId) : undefined
		if (entry.type === "label" && !targetGlobalId) throw new Error(`Entry ${entry.targetId} not found`)
		const ownerRunId = mutationOwnerRunId(options)
		this.#db.exec("BEGIN IMMEDIATE")
		try {
			assertSessionMutationAllowed(this.#db, this.#metadata.id, this.#mutationVersion, ownerRunId)
			const seq = nextSessionSeq(this.#db, this.#metadata.id)
			insertEntry(this.#db, this.#metadata.id, seq, entry, { globalId, parentGlobalId, targetGlobalId })
			this.#db.prepare(`
				UPDATE sessions
				SET active_leaf_entry_id = ?,
					active_leaf_global_id = ?,
					mutation_version = mutation_version + 1
				WHERE id = ? AND deleted_at IS NULL
			`)
				.run(entry.id, globalId, this.#metadata.id)
			this.#db.exec("COMMIT")
		} catch (err) {
			this.#db.exec("ROLLBACK")
			throw err
		}
		this.#entries.push(entry)
		this.#byId.set(entry.id, entry)
		this.#globalById.set(entry.id, globalId)
		if (entry.type === "label") {
			const trimmed = entry.label?.trim()
			if (trimmed) this.#labels.set(entry.targetId, trimmed)
			else this.#labels.delete(entry.targetId)
		}
		this.#leafId = entry.id
		this.#mutationVersion += 1
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

function loadEntries(db, sessionId) {
	const rows = db.prepare(`
		SELECT
			ser.global_id AS globalId,
			ce.id,
			parent.id AS parentId,
			ce.timestamp,
			ce.kind AS type
		FROM session_entry_refs ser
		JOIN conversation_entries ce ON ce.global_id = ser.global_id
		LEFT JOIN conversation_entries parent ON parent.global_id = ce.parent_global_id
		WHERE ser.session_id = ?
		ORDER BY ser.seq ASC
	`).all(sessionId)
	const entryGlobalIds = new Map(rows.map((row) => [row.id, row.globalId]))
	return { entries: rows.map((row) => loadEntry(db, row)), entryGlobalIds }
}

function withContextLoad(db, globalId, entry) {
	const contextLoad = loadContextLoad(db, globalId)
	return contextLoad ? { ...entry, contextLoad } : entry
}

function loadEntry(db, row) {
	const base = { id: row.id, parentId: row.parentId ?? null, timestamp: row.timestamp }
	if (row.type === "message") return withContextLoad(db, row.globalId, { ...base, type: "message", message: loadMessage(db, row.globalId) })
	if (row.type === "label") {
		const label = db.prepare(`
			SELECT target.id AS targetId, el.label
			FROM entry_labels el
			JOIN conversation_entries target ON target.global_id = el.target_global_id
			WHERE el.global_id = ?
		`).get(row.globalId)
		return withContextLoad(db, row.globalId, { ...base, type: "label", targetId: label?.targetId, label: label?.label ?? undefined })
	}
	if (row.type === "custom") {
		const custom = db.prepare("SELECT custom_type AS customType FROM entry_custom_entries WHERE global_id = ?").get(row.globalId)
		const customType = custom?.customType ?? "unknown"
		const data = customType === "tool_execution" ? loadToolExecutionData(db, row.globalId) : loadCustomData(db, row.globalId)
		return withContextLoad(db, row.globalId, { ...base, type: "custom", customType, data })
	}
	if (row.type === "context") return { ...base, type: "context", contextLoad: loadContextLoad(db, row.globalId) ?? { source: "unknown", files: [] } }
	throw new Error(`Unsupported session entry kind in database: ${row.type}`)
}

function loadCustomData(db, globalId) {
	const row = db.prepare("SELECT data_json AS dataJson FROM entry_custom_entries WHERE global_id = ?").get(globalId)
	return parseJson(row?.dataJson)
}

function withDefined(object, key, value) {
	if (value !== null && value !== undefined) object[key] = value
	return object
}

function defineLazyJsonField(object, key, loadText) {
	let loaded = false
	let value
	Object.defineProperty(object, key, {
		enumerable: true,
		configurable: true,
		get() {
			if (!loaded) {
				value = parseJson(loadText())
				loaded = true
			}
			return value
		},
	})
	return object
}

function loadToolExecutionData(db, globalId) {
	const row = db.prepare(`
		SELECT
			CASE
				WHEN NOT json_valid(data_json) THEN data_json
				WHEN COALESCE(json_extract(data_json, '$.phase'), '') != 'ended' THEN data_json
				ELSE NULL
			END AS dataJson,
			CASE WHEN json_valid(data_json) THEN json_extract(data_json, '$.version') END AS version,
			CASE WHEN json_valid(data_json) THEN json_extract(data_json, '$.phase') END AS phase,
			CASE WHEN json_valid(data_json) THEN json_extract(data_json, '$.runId') END AS runId,
			CASE WHEN json_valid(data_json) THEN json_extract(data_json, '$.toolCallId') END AS toolCallId,
			CASE WHEN json_valid(data_json) THEN json_extract(data_json, '$.toolName') END AS toolName,
			CASE WHEN json_valid(data_json) THEN json_extract(data_json, '$.isError') END AS isError,
			CASE WHEN json_valid(data_json) THEN json_extract(data_json, '$.messageEntryId') END AS messageEntryId,
			CASE WHEN json_valid(data_json) THEN json_extract(data_json, '$.hasDurableMessage') END AS hasDurableMessage,
			CASE WHEN json_valid(data_json) AND json_type(data_json, '$.message') IS NOT NULL THEN 1 ELSE 0 END AS hasRecoveryMessage
		FROM entry_custom_entries
		WHERE global_id = ?
	`).get(globalId)
	if (!row) return undefined
	if (row.dataJson !== null && row.dataJson !== undefined) return parseJson(row.dataJson)
	const data = {}
	withDefined(data, "version", row.version)
	withDefined(data, "phase", row.phase)
	withDefined(data, "runId", row.runId)
	withDefined(data, "toolCallId", row.toolCallId)
	withDefined(data, "toolName", row.toolName)
	if (row.isError !== null && row.isError !== undefined) data.isError = intToBool(row.isError)
	withDefined(data, "messageEntryId", row.messageEntryId)
	if (row.hasDurableMessage !== null && row.hasDurableMessage !== undefined) data.hasDurableMessage = intToBool(row.hasDurableMessage)
	if (row.hasRecoveryMessage) {
		data.hasRecoveryMessage = true
		defineLazyJsonField(data, "message", () => db.prepare(`
			SELECT CASE WHEN json_valid(data_json) THEN json_extract(data_json, '$.message') END AS messageJson
			FROM entry_custom_entries
			WHERE global_id = ?
		`).get(globalId)?.messageJson)
	}
	return data
}

function loadContextLoad(db, globalId) {
	let row
	try {
		row = db.prepare("SELECT source, cwd, loaded_at AS loadedAt, disabled FROM entry_context_loads WHERE global_id = ?").get(globalId)
	} catch {
		return undefined
	}
	if (!row) return undefined
	const files = db.prepare(`
		SELECT path, scope_dir AS scopeDir, content, hash
		FROM entry_context_files
		WHERE global_id = ?
		ORDER BY ordinal ASC
	`).all(globalId)
	return {
		source: row.source,
		...(row.cwd ? { cwd: row.cwd } : {}),
		loadedAt: row.loadedAt,
		disabled: intToBool(row.disabled),
		files,
	}
}

export function loadMessage(db, globalId) {
	const row = db.prepare(`
		SELECT
			role,
			content_format AS contentFormat,
			timestamp,
			provider,
			model,
			auth_json AS authJson,
			response_model AS responseModel,
			response_id AS responseId,
			model_request_id AS modelRequestId,
			stop_reason AS stopReason,
			error_message AS errorMessage,
			tool_call_id AS toolCallId,
			tool_name AS toolName,
			is_error AS isError,
			details_json AS detailsJson,
			extra_json AS extraJson
		FROM entry_messages
		WHERE global_id = ?
	`).get(globalId)
	if (!row) return { role: "unknown", content: [] }
	const blockRows = db.prepare(`
		SELECT
			ordinal,
			type,
			text,
			text_signature AS textSignature,
			thinking,
			thinking_signature AS thinkingSignature,
			redacted,
			image_data AS imageData,
			image_mime_type AS imageMimeType,
			image_detail AS imageDetail,
			image_width_px AS imageWidthPx,
			image_height_px AS imageHeightPx,
			tool_call_id AS toolCallId,
			tool_name AS toolName,
			tool_args_json AS toolArgsJson,
			tool_input AS toolInput,
			payload_json AS payloadJson
		FROM entry_message_blocks
		WHERE global_id = ?
		ORDER BY ordinal ASC
	`).all(globalId)
	const blocks = blockRows.map(deserializeBlock)
	const content = row.contentFormat === "string" ? (blocks[0]?.text ?? "") : blocks
	const usage = loadUsage(db, globalId)
	const extra = parseJson(row.extraJson, {}) ?? {}
	const base = { role: row.role, ...extra }
	if (row.timestamp !== null && row.timestamp !== undefined) base.timestamp = row.timestamp
	if (row.role === "assistant") {
		return {
			...base,
			role: "assistant",
			content,
			provider: row.provider ?? "",
			model: row.model ?? "",
			...(row.authJson ? { auth: parseJson(row.authJson) } : {}),
			...(row.responseModel ? { responseModel: row.responseModel } : {}),
			...(row.responseId ? { responseId: row.responseId } : {}),
			...(row.modelRequestId ? { modelRequestId: row.modelRequestId } : {}),
			usage: usage ?? {},
			stopReason: row.stopReason ?? "stop",
			...(row.errorMessage ? { errorMessage: row.errorMessage } : {}),
		}
	}
	if (row.role === "toolResult") {
		return {
			...base,
			role: "toolResult",
			toolCallId: row.toolCallId ?? "",
			toolName: row.toolName ?? "",
			content,
			isError: intToBool(row.isError),
			...(row.detailsJson ? { details: parseJson(row.detailsJson) } : {}),
		}
	}
	return { ...base, role: row.role, content }
}

function loadUsage(db, globalId) {
	const row = db.prepare(`
		SELECT
			input_tokens AS input,
			output_tokens AS output,
			reasoning_output_tokens AS reasoningOutput,
			cache_read_tokens AS cacheRead,
			cache_write_tokens AS cacheWrite,
			total_tokens AS totalTokens,
			provider_total_tokens AS providerTotalTokens,
			cost_input AS costInput,
			cost_output AS costOutput,
			cost_cache_read AS costCacheRead,
			cost_cache_write AS costCacheWrite,
			cost_total AS costTotal,
			cost_currency AS currency,
			pricing_version AS pricingVersion,
			raw_json AS rawJson
		FROM entry_usage
		WHERE global_id = ?
	`).get(globalId)
	if (!row) return undefined
	return {
		input: row.input ?? 0,
		output: row.output ?? 0,
		...(row.reasoningOutput !== null && row.reasoningOutput !== undefined ? { reasoningOutput: row.reasoningOutput } : {}),
		cacheRead: row.cacheRead ?? 0,
		cacheWrite: row.cacheWrite ?? 0,
		totalTokens: row.totalTokens ?? 0,
		...(row.providerTotalTokens !== null && row.providerTotalTokens !== undefined ? { providerTotalTokens: row.providerTotalTokens } : {}),
		...(row.rawJson ? { raw: parseJson(row.rawJson) } : {}),
		cost: {
			input: row.costInput ?? 0,
			output: row.costOutput ?? 0,
			cacheRead: row.costCacheRead ?? 0,
			cacheWrite: row.costCacheWrite ?? 0,
			total: row.costTotal ?? 0,
			...(row.currency ? { currency: row.currency } : {}),
			...(row.pricingVersion ? { pricingVersion: row.pricingVersion } : {}),
		},
	}
}

export function insertEntry(db, sessionId, seq, entry, ids) {
	db.prepare(`
		INSERT INTO conversation_entries (global_id, id, parent_global_id, created_by_session_id, timestamp, kind)
		VALUES (?, ?, ?, ?, ?, ?)
	`).run(ids.globalId, entry.id, ids.parentGlobalId ?? null, sessionId, entry.timestamp, entryKind(entry))
	db.prepare("INSERT INTO session_entry_refs (session_id, global_id, seq) VALUES (?, ?, ?)")
		.run(sessionId, ids.globalId, seq)
	if (entry.type === "message") insertMessage(db, ids.globalId, entry.message)
	else if (entry.type === "label") {
		db.prepare("INSERT INTO entry_labels (global_id, target_global_id, label) VALUES (?, ?, ?)")
			.run(ids.globalId, ids.targetGlobalId, entry.label ?? null)
	} else if (entry.type === "custom") {
		db.prepare("INSERT INTO entry_custom_entries (global_id, custom_type, data_json) VALUES (?, ?, ?)")
			.run(ids.globalId, entry.customType, jsonOrNull(entry.data))
	} else if (entry.type === "context") {
		insertContextLoad(db, ids.globalId, entry.contextLoad ?? { source: "unknown", files: [] })
	}
}

function insertContextLoad(db, globalId, load) {
	db.prepare(`
		INSERT INTO entry_context_loads (global_id, source, cwd, loaded_at, disabled)
		VALUES (?, ?, ?, ?, ?)
	`).run(globalId, load.source ?? "unknown", load.cwd ?? null, load.loadedAt ?? new Date().toISOString(), load.disabled ? 1 : 0)
	;(load.files ?? []).forEach((file, ordinal) => {
		db.prepare(`
			INSERT INTO entry_context_files (global_id, ordinal, path, scope_dir, content, hash)
			VALUES (?, ?, ?, ?, ?, ?)
		`).run(globalId, ordinal, file.path, file.scopeDir ?? null, file.content ?? "", file.hash ?? null)
	})
}

function insertMessage(db, globalId, message) {
	const usage = message?.usage
	db.prepare(`
		INSERT INTO entry_messages (
			global_id,
			role,
			content_format,
			timestamp,
			provider,
			model,
			auth_json,
			response_model,
			response_id,
			model_request_id,
			stop_reason,
			error_message,
			tool_call_id,
			tool_name,
			is_error,
			details_json,
			extra_json
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(
		globalId,
		message?.role ?? "unknown",
		contentFormatFor(message),
		numberOrNull(message?.timestamp),
		message?.provider ?? null,
		message?.model ?? null,
		jsonOrNull(message?.auth),
		message?.responseModel ?? null,
		message?.responseId ?? null,
		message?.modelRequestId ?? null,
		message?.stopReason ?? null,
		message?.errorMessage ?? null,
		message?.toolCallId ?? null,
		message?.toolName ?? null,
		message?.role === "toolResult" ? boolToInt(message?.isError) : null,
		jsonOrNull(message?.details),
		jsonOrNull(extraMessageFields(message)),
	)
	contentBlocksFor(message).forEach((block, ordinal) => insertMessageBlock(db, globalId, ordinal, block))
	if (usage) insertUsage(db, globalId, usage)
}

function insertMessageBlock(db, globalId, ordinal, block) {
	const row = serializeBlock(block)
	db.prepare(`
		INSERT INTO entry_message_blocks (
			global_id,
			ordinal,
			type,
			text,
			text_signature,
			thinking,
			thinking_signature,
			redacted,
			image_data,
			image_mime_type,
			image_detail,
			image_width_px,
			image_height_px,
			tool_call_id,
			tool_name,
			tool_args_json,
			tool_input,
			payload_json
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(
		globalId,
		ordinal,
		row.type,
		row.text ?? null,
		row.textSignature ?? null,
		row.thinking ?? null,
		row.thinkingSignature ?? null,
		row.redacted ?? null,
		row.imageData ?? null,
		row.imageMimeType ?? null,
		row.imageDetail ?? null,
		row.imageWidthPx ?? null,
		row.imageHeightPx ?? null,
		row.toolCallId ?? null,
		row.toolName ?? null,
		row.toolArgsJson ?? null,
		row.toolInput ?? null,
		row.payloadJson ?? null,
	)
}

function insertUsage(db, globalId, usage) {
	const cost = usage.cost ?? {}
	db.prepare(`
		INSERT INTO entry_usage (
			global_id,
			input_tokens,
			output_tokens,
			reasoning_output_tokens,
			cache_read_tokens,
			cache_write_tokens,
			total_tokens,
			provider_total_tokens,
			cost_input,
			cost_output,
			cost_cache_read,
			cost_cache_write,
			cost_total,
			cost_currency,
			pricing_version,
			raw_json
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(
		globalId,
		numberOrNull(usage.input) ?? 0,
		numberOrNull(usage.output) ?? 0,
		numberOrNull(usage.reasoningOutput),
		numberOrNull(usage.cacheRead) ?? 0,
		numberOrNull(usage.cacheWrite) ?? 0,
		numberOrNull(usage.totalTokens) ?? 0,
		numberOrNull(usage.providerTotalTokens),
		numberOrNull(cost.input) ?? 0,
		numberOrNull(cost.output) ?? 0,
		numberOrNull(cost.cacheRead) ?? 0,
		numberOrNull(cost.cacheWrite) ?? 0,
		numberOrNull(cost.total) ?? 0,
		cost.currency ?? null,
		cost.pricingVersion ?? usage.pricingVersion ?? null,
		jsonOrNull(usage.raw),
	)
}
