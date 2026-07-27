import { randomUUID } from "node:crypto"

import {
	ensureSessionOverviewProjection,
	recomputeSessionOverviewProjections,
	updateSessionOverviewForAppendedEntry,
} from "./session-overviews.js"
import { normalizeLegacyEntryData, normalizeLegacyMetadata } from "./metadata-compatibility.js"

/** @typedef {import("./types.js").SessionEntry} SessionEntry */
/** @typedef {import("./types.js").SessionMetadata} SessionMetadata */
/** @typedef {{ enabled?: boolean, span?: (name: string, args?: Record<string, any>) => (extraArgs?: Record<string, any>) => void }} StorageDiagnostics */

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

function imageOriginalOrNull(original) {
	if (!original || typeof original !== "object") return null
	if (typeof original.data !== "string" || typeof original.mimeType !== "string") return null
	return {
		data: original.data,
		mimeType: original.mimeType,
		widthPx: numberOrNull(original.widthPx),
		heightPx: numberOrNull(original.heightPx),
	}
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
		const original = imageOriginalOrNull(block.original)
		const attachmentId = typeof block.attachmentId === "string" && block.attachmentId ? block.attachmentId : null
		return {
			type,
			imageData: attachmentId ? null : block.data ?? "",
			imageMimeType: block.mimeType ?? null,
			imageDetail: block.detail ?? null,
			imageWidthPx: numberOrNull(block.widthPx),
			imageHeightPx: numberOrNull(block.heightPx),
			imageOriginalData: attachmentId ? null : original?.data ?? null,
			imageOriginalMimeType: original?.mimeType ?? null,
			imageOriginalWidthPx: original?.widthPx ?? null,
			imageOriginalHeightPx: original?.heightPx ?? null,
			imageAttachmentId: attachmentId,
			imageNumber: numberOrNull(block.imageNumber),
			imageAttachmentSessionId: block.attachmentSessionId ?? null,
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
		if (row.imageAttachmentId) {
			const original = row.imageOriginalStorageKey || row.imageOriginalPath
				? {
					mimeType: row.imageOriginalMimeType ?? "application/octet-stream",
					...(row.imageOriginalWidthPx !== null && row.imageOriginalWidthPx !== undefined ? { widthPx: row.imageOriginalWidthPx } : {}),
					...(row.imageOriginalHeightPx !== null && row.imageOriginalHeightPx !== undefined ? { heightPx: row.imageOriginalHeightPx } : {}),
					...(row.imageOriginalStorageKey ? { storageKey: row.imageOriginalStorageKey } : {}),
					...(row.imageOriginalPath ? { path: row.imageOriginalPath } : {}),
				}
				: null
			return {
				type: "image",
				attachmentId: row.imageAttachmentId,
				...(row.imageAttachmentSessionId ? { attachmentSessionId: row.imageAttachmentSessionId } : {}),
				...(row.imageNumber !== null && row.imageNumber !== undefined ? { imageNumber: row.imageNumber } : {}),
				mimeType: row.imageMimeType ?? "application/octet-stream",
				...(row.imageDetail ? { detail: row.imageDetail } : {}),
				...(row.imageWidthPx !== null && row.imageWidthPx !== undefined ? { widthPx: row.imageWidthPx } : {}),
				...(row.imageHeightPx !== null && row.imageHeightPx !== undefined ? { heightPx: row.imageHeightPx } : {}),
				...(row.imageStorageKey ? { storageKey: row.imageStorageKey } : {}),
				...(row.imagePath ? { path: row.imagePath } : {}),
				...(original ? { original } : {}),
			}
		}
		const original = row.imageOriginalData
			? {
				data: row.imageOriginalData,
				mimeType: row.imageOriginalMimeType ?? "application/octet-stream",
				...(row.imageOriginalWidthPx !== null && row.imageOriginalWidthPx !== undefined ? { widthPx: row.imageOriginalWidthPx } : {}),
				...(row.imageOriginalHeightPx !== null && row.imageOriginalHeightPx !== undefined ? { heightPx: row.imageOriginalHeightPx } : {}),
			}
			: null
		return {
			type: "image",
			data: row.imageData ?? "",
			mimeType: row.imageMimeType ?? "application/octet-stream",
			...(row.imageDetail ? { detail: row.imageDetail } : {}),
			...(row.imageWidthPx !== null && row.imageWidthPx !== undefined ? { widthPx: row.imageWidthPx } : {}),
			...(row.imageHeightPx !== null && row.imageHeightPx !== undefined ? { heightPx: row.imageHeightPx } : {}),
			...(original ? { original } : {}),
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
	if (!row) throw storageMutationError(`Session not found: ${sessionId}`, "CEREX_SESSION_NOT_FOUND")
	const actualVersion = Number(row.mutationVersion ?? 0)
	if (actualVersion !== expectedVersion) {
		throw storageMutationError(`Session ${sessionId} changed in the database; reopen it before mutating.`, "CEREX_SESSION_STALE")
	}
	const actualOwnerRunId = row.mutationRunId ?? null
	if (actualOwnerRunId !== ownerRunId) {
		throw storageMutationError(
			actualOwnerRunId
				? `Session ${sessionId} is being mutated by another run.`
				: `Run ${ownerRunId} does not own session ${sessionId}.`,
			"CEREX_SESSION_MUTATION_OWNER_MISMATCH",
		)
	}
}

function nextSessionSeq(db, sessionId) {
	const row = db.prepare("SELECT COALESCE(MAX(seq) + 1, 0) AS seq FROM session_entry_refs WHERE session_id = ?").get(sessionId)
	return Number(row?.seq ?? 0)
}

const runUntraced = (_stage, task) => task()

function storageTracer(diagnostics, operation, args) {
	if (diagnostics?.enabled === false || typeof diagnostics?.span !== "function") return runUntraced
	return (stage, task) => {
		const end = diagnostics?.span?.(`SqliteSessionStorage.${operation}.${stage}`, args)
		try {
			return task()
		} finally {
			end?.()
		}
	}
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
	#diagnostics

	constructor(db, metadata, entries, entryGlobalIds, leafId, mutationVersion, diagnostics) {
		this.#db = db
		this.#metadata = metadata
		this.#entries = entries
		this.#byId = new Map(entries.map((e) => [e.id, e]))
		this.#globalById = entryGlobalIds
		this.#labels = buildLabelMap(entries)
		this.#leafId = leafId
		this.#mutationVersion = mutationVersion
		this.#diagnostics = diagnostics
	}

	static create(db, options) {
		const createdAt = options.createdAt ?? new Date().toISOString()
		const initialWd = typeof options.initialWd === "string" && options.initialWd ? options.initialWd : options.cwd
		db.prepare(`
			INSERT INTO sessions (id, cwd, initial_wd, name, created_at, updated_at, deleted_at, active_leaf_entry_id, active_leaf_global_id)
			VALUES (?, ?, ?, NULL, ?, ?, NULL, NULL, NULL)
			ON CONFLICT(id) DO UPDATE SET
				cwd = excluded.cwd,
				initial_wd = COALESCE(sessions.initial_wd, excluded.initial_wd),
				created_at = COALESCE(sessions.created_at, excluded.created_at),
				updated_at = excluded.updated_at,
				deleted_at = NULL,
				active_leaf_entry_id = COALESCE(sessions.active_leaf_entry_id, excluded.active_leaf_entry_id),
				active_leaf_global_id = COALESCE(sessions.active_leaf_global_id, excluded.active_leaf_global_id)
		`).run(options.sessionId, options.cwd, initialWd, createdAt, options.updatedAt ?? createdAt)
		const row = db.prepare(`
			SELECT
				mutation_version AS mutationVersion,
				active_leaf_entry_id AS activeLeafEntryId,
				active_leaf_global_id AS activeLeafGlobalId
			FROM sessions
			WHERE id = ?
		`).get(options.sessionId)
		if (row?.activeLeafEntryId || row?.activeLeafGlobalId) recomputeSessionOverviewProjections(db, [options.sessionId])
		else ensureSessionOverviewProjection(db, options.sessionId)
		return new SqliteSessionStorage(db, {
			id: options.sessionId,
			createdAt,
			cwd: options.cwd,
		}, [], new Map(), null, Number(row?.mutationVersion ?? 0), options.diagnostics)
	}

	static branchFrom(db, sourceSessionId, options = {}) {
		const createdAt = options.createdAt ?? new Date().toISOString()
		const targetSessionId = options.sessionId ?? randomUUID()
		const hasSourceEntryId = Object.prototype.hasOwnProperty.call(options, "sourceEntryId") && options.sourceEntryId !== undefined
		const source = db.prepare(`
			SELECT id, cwd, active_leaf_entry_id AS activeLeafEntryId, active_leaf_global_id AS activeLeafGlobalId
			FROM sessions
			WHERE id = ? AND deleted_at IS NULL
		`).get(sourceSessionId)
		if (!source) throw new Error(`Session not found: ${sourceSessionId}`)
		const targetCwd = options.cwd ?? source.cwd
		const targetInitialWd = typeof options.initialWd === "string" && options.initialWd ? options.initialWd : targetCwd
		const sourceEntryId = hasSourceEntryId ? options.sourceEntryId : source.activeLeafEntryId
		if (sourceEntryId !== null && sourceEntryId !== undefined && (typeof sourceEntryId !== "string" || !sourceEntryId)) throw new Error("sourceEntryId must be a non-empty string or null")
		const sourceEntryGlobalIdStmt = db.prepare(`
			SELECT ser.global_id AS globalId
			FROM session_entry_refs ser
			JOIN conversation_entries ce ON ce.global_id = ser.global_id
			WHERE ser.session_id = ? AND ce.id = ?
			LIMIT 1
		`)
		const sourceEntryGlobalIdFor = (entryId) => entryId
			? sourceEntryGlobalIdStmt.get(sourceSessionId, entryId)?.globalId
			: null
		const sourceEntryGlobalId = hasSourceEntryId
			? sourceEntryGlobalIdFor(sourceEntryId)
			: source.activeLeafGlobalId ?? sourceEntryGlobalIdFor(source.activeLeafEntryId)
		if (hasSourceEntryId && sourceEntryId && !sourceEntryGlobalId) throw new Error(`Entry not found in session ${sourceSessionId}: ${sourceEntryId}`)
		const branch = sourceEntryGlobalId
			? db.prepare(`
				WITH RECURSIVE
					branch(global_id, parent_global_id, depth) AS (
						SELECT ce.global_id, ce.parent_global_id, 0
						FROM conversation_entries ce
						WHERE ce.global_id = ?
						UNION ALL
						SELECT parent.global_id, parent.parent_global_id, branch.depth + 1
						FROM branch
						JOIN conversation_entries parent ON parent.global_id = branch.parent_global_id
					)
				SELECT branch.global_id AS globalId, ce.id, branch.depth
				FROM branch
				JOIN conversation_entries ce ON ce.global_id = branch.global_id
				ORDER BY branch.depth DESC
			`).all(sourceEntryGlobalId)
			: []
		const activeLeaf = branch.at(-1)
		const activeLeafEntryId = activeLeaf?.id ?? (hasSourceEntryId ? null : source.activeLeafEntryId ?? null)
		const activeLeafGlobalId = activeLeaf?.globalId ?? (hasSourceEntryId ? null : source.activeLeafGlobalId ?? null)
		db.exec("BEGIN IMMEDIATE")
		try {
			db.prepare(`
				INSERT INTO sessions (
					id,
					cwd,
					initial_wd,
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
				VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
			`).run(
				targetSessionId,
				targetCwd,
				targetInitialWd,
				createdAt,
				createdAt,
				activeLeafEntryId,
				activeLeafGlobalId,
				sourceSessionId,
				activeLeafEntryId,
				activeLeafGlobalId,
				createdAt,
			)
			const insertRef = db.prepare("INSERT INTO session_entry_refs (session_id, global_id, seq) VALUES (?, ?, ?)")
			branch.forEach((entry, seq) => insertRef.run(targetSessionId, entry.globalId, seq))
			recomputeSessionOverviewProjections(db, [targetSessionId])
			db.exec("COMMIT")
		} catch (err) {
			db.exec("ROLLBACK")
			throw err
		}
		return SqliteSessionStorage.open(db, targetSessionId, { diagnostics: options.diagnostics })
	}

	static open(db, sessionId, options = {}) {
		const diagnostics = options.diagnostics
		const spanArgs = { sessionId }
		const trace = storageTracer(diagnostics, "open", spanArgs)
		const row = trace("metadata", () => db.prepare(`
				SELECT
					id,
					cwd,
					created_at AS createdAt,
					active_leaf_entry_id AS activeLeafEntryId,
					active_leaf_global_id AS activeLeafGlobalId,
					mutation_version AS mutationVersion
				FROM sessions
				WHERE id = ? AND deleted_at IS NULL
			`).get(sessionId))
		if (!row) throw new Error(`Session not found: ${sessionId}`)
		const loaded = trace("entries", () => loadEntries(db, sessionId))
		const { entries, entryGlobalIds } = loaded
		const activeLeaf = trace("resolveLeaf", () => {
			const last = db.prepare(`
				SELECT ce.id, ser.seq
				FROM session_entry_refs ser
				JOIN conversation_entries ce ON ce.global_id = ser.global_id
				WHERE ser.session_id = ?
				ORDER BY ser.seq DESC
				LIMIT 1
			`).get(sessionId)
			const entryIdByGlobalId = new Map([...entryGlobalIds].map(([id, globalId]) => [globalId, id]))
			let leaf = last?.id ?? null
			if (row.activeLeafEntryId && entries.some((entry) => entry.id === row.activeLeafEntryId)) {
				leaf = row.activeLeafEntryId
			}
			if (row.activeLeafGlobalId && entryIdByGlobalId.has(row.activeLeafGlobalId)) {
				leaf = entryIdByGlobalId.get(row.activeLeafGlobalId)
			}
			return leaf
		})
		return new SqliteSessionStorage(db, {
			id: row.id,
			createdAt: row.createdAt,
			cwd: row.cwd,
		}, entries, entryGlobalIds, activeLeaf, Number(row.mutationVersion ?? 0), diagnostics)
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
			recomputeSessionOverviewProjections(this.#db, [this.#metadata.id])
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
		const spanArgs = {
			sessionId: this.#metadata.id,
			entryType: entry.type,
			messageRole: entry.type === "message" ? entry.message.role : undefined,
			customType: entry.type === "custom" ? entry.customType : undefined,
		}
		const trace = storageTracer(this.#diagnostics, "appendEntry", spanArgs)
		trace("begin", () => this.#db.exec("BEGIN IMMEDIATE"))
		try {
			trace("guard", () => {
				assertSessionMutationAllowed(this.#db, this.#metadata.id, this.#mutationVersion, ownerRunId)
			})
			const seq = trace("sequence", () => nextSessionSeq(this.#db, this.#metadata.id))
			trace("insert", () => {
				insertEntry(this.#db, this.#metadata.id, seq, entry, { globalId, parentGlobalId, targetGlobalId })
			})
			trace("updateSession", () => this.#db.prepare(`
					UPDATE sessions
					SET active_leaf_entry_id = ?,
						active_leaf_global_id = ?,
						mutation_version = mutation_version + 1
					WHERE id = ? AND deleted_at IS NULL
				`)
				.run(entry.id, globalId, this.#metadata.id))
			trace("updateOverview", () => {
				updateSessionOverviewForAppendedEntry(this.#db, this.#metadata.id, entry, entry.id)
			})
			trace("commit", () => this.#db.exec("COMMIT"))
		} catch (err) {
			trace("rollback", () => this.#db.exec("ROLLBACK"))
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

const MESSAGE_COLUMNS_SQL = `
	em.global_id AS globalId,
	em.role,
	em.content_format AS contentFormat,
	em.timestamp,
	em.provider,
	em.model,
	em.auth_json AS authJson,
	em.response_model AS responseModel,
	em.response_id AS responseId,
	em.model_request_id AS modelRequestId,
	em.stop_reason AS stopReason,
	em.error_message AS errorMessage,
	em.tool_call_id AS toolCallId,
	em.tool_name AS toolName,
	em.is_error AS isError,
	em.details_json AS detailsJson,
	em.extra_json AS extraJson
`

const MESSAGE_BLOCK_COLUMNS_SQL = `
	emb.ordinal,
	emb.type,
	emb.text,
	emb.text_signature AS textSignature,
	emb.thinking,
	emb.thinking_signature AS thinkingSignature,
	emb.redacted,
	emb.image_data AS imageData,
	COALESCE(emb.image_mime_type, sav.mime_type) AS imageMimeType,
	COALESCE(emb.image_detail, sa.detail) AS imageDetail,
	COALESCE(emb.image_width_px, sav.width_px) AS imageWidthPx,
	COALESCE(emb.image_height_px, sav.height_px) AS imageHeightPx,
	emb.image_attachment_id AS imageAttachmentId,
	emb.image_number AS imageNumber,
	COALESCE(emb.image_attachment_session_id, sa.session_id) AS imageAttachmentSessionId,
	sav.storage_key AS imageStorageKey,
	sav.file_path AS imagePath,
	emb.image_original_data AS imageOriginalData,
	COALESCE(emb.image_original_mime_type, saov.mime_type) AS imageOriginalMimeType,
	COALESCE(emb.image_original_width_px, saov.width_px) AS imageOriginalWidthPx,
	COALESCE(emb.image_original_height_px, saov.height_px) AS imageOriginalHeightPx,
	saov.storage_key AS imageOriginalStorageKey,
	saov.file_path AS imageOriginalPath,
	emb.tool_call_id AS toolCallId,
	emb.tool_name AS toolName,
	emb.tool_args_json AS toolArgsJson,
	emb.tool_input AS toolInput,
	emb.payload_json AS payloadJson
`

const USAGE_COLUMNS_SQL = `
	eu.global_id AS globalId,
	eu.input_tokens AS input,
	eu.output_tokens AS output,
	eu.reasoning_output_tokens AS reasoningOutput,
	eu.cache_read_tokens AS cacheRead,
	eu.cache_write_tokens AS cacheWrite,
	eu.total_tokens AS totalTokens,
	eu.provider_total_tokens AS providerTotalTokens,
	eu.cost_input AS costInput,
	eu.cost_output AS costOutput,
	eu.cost_cache_read AS costCacheRead,
	eu.cost_cache_write AS costCacheWrite,
	eu.cost_total AS costTotal,
	eu.cost_currency AS currency,
	eu.pricing_version AS pricingVersion,
	eu.raw_json AS rawJson
`

const CUSTOM_ENTRY_DATA_COLUMNS_SQL = `
	CASE
		WHEN ece.custom_type != 'tool_execution' THEN ece.data_json
		WHEN NOT json_valid(ece.data_json) THEN ece.data_json
		WHEN COALESCE(json_extract(ece.data_json, '$.phase'), '') != 'ended' THEN ece.data_json
		ELSE NULL
	END AS dataJson,
	CASE WHEN ece.custom_type = 'tool_execution' AND json_valid(ece.data_json) THEN json_extract(ece.data_json, '$.version') END AS customVersion,
	CASE WHEN ece.custom_type = 'tool_execution' AND json_valid(ece.data_json) THEN json_extract(ece.data_json, '$.phase') END AS customPhase,
	CASE WHEN ece.custom_type = 'tool_execution' AND json_valid(ece.data_json) THEN json_extract(ece.data_json, '$.runId') END AS customRunId,
	CASE WHEN ece.custom_type = 'tool_execution' AND json_valid(ece.data_json) THEN json_extract(ece.data_json, '$.toolCallId') END AS customToolCallId,
	CASE WHEN ece.custom_type = 'tool_execution' AND json_valid(ece.data_json) THEN json_extract(ece.data_json, '$.toolName') END AS customToolName,
	CASE WHEN ece.custom_type = 'tool_execution' AND json_valid(ece.data_json) THEN json_extract(ece.data_json, '$.isError') END AS customIsError,
	CASE WHEN ece.custom_type = 'tool_execution' AND json_valid(ece.data_json) THEN json_extract(ece.data_json, '$.messageEntryId') END AS customMessageEntryId,
	CASE WHEN ece.custom_type = 'tool_execution' AND json_valid(ece.data_json) THEN json_extract(ece.data_json, '$.hasDurableMessage') END AS customHasDurableMessage,
	CASE WHEN ece.custom_type = 'tool_execution' AND json_valid(ece.data_json) AND json_type(ece.data_json, '$.message') IS NOT NULL THEN 1 ELSE 0 END AS customHasRecoveryMessage
`

function groupedRowsByGlobalId(rows) {
	return rows.reduce((groups, row) => {
		const group = groups.get(row.globalId) ?? []
		group.push(row)
		groups.set(row.globalId, group)
		return groups
	}, new Map())
}

function rowsByGlobalId(rows) {
	return new Map(rows.map((row) => [row.globalId, row]))
}

// Session refs point throughout global entry tables. Resolve rowids through their indexes first, then read payload rows in physical order so cold opens do not become thousands of random table-page reads.
function selectedEntryRowIdsSql(table, condition = "") {
	return `
		SELECT selected.rowid
		FROM session_entry_refs ser
		JOIN ${table} selected ON selected.global_id = ser.global_id
		WHERE ser.session_id = ? ${condition}
	`
}

function loadEntries(db, sessionId) {
	const refs = db.prepare(`
		SELECT global_id AS globalId
		FROM session_entry_refs
		WHERE session_id = ?
		ORDER BY seq ASC
	`).all(sessionId)
	const entryRows = rowsByGlobalId(db.prepare(`
		SELECT
			ce.global_id AS globalId,
			ce.id,
			ce.parent_global_id AS parentGlobalId,
			ce.timestamp AS entryTimestamp,
			ce.kind AS entryType
		FROM conversation_entries ce
		WHERE ce.rowid IN (${selectedEntryRowIdsSql("conversation_entries")})
		ORDER BY ce.rowid ASC
	`).all(sessionId))
	const rows = refs.map((ref) => entryRows.get(ref.globalId)).filter(Boolean).map((row) => ({
		...row,
		parentId: row.parentGlobalId ? entryRows.get(row.parentGlobalId)?.id : null,
	}))
	const messages = rowsByGlobalId(db.prepare(`
		SELECT ${MESSAGE_COLUMNS_SQL}
		FROM entry_messages em
		WHERE em.rowid IN (${selectedEntryRowIdsSql("entry_messages")})
		ORDER BY em.rowid ASC
	`).all(sessionId))
	const commonBlockRows = db.prepare(`
		SELECT
			emb.global_id AS globalId,
			emb.ordinal,
			emb.type,
			emb.text,
			emb.text_signature AS textSignature,
			emb.thinking,
			emb.thinking_signature AS thinkingSignature,
			emb.redacted,
			emb.tool_call_id AS toolCallId,
			emb.tool_name AS toolName,
			emb.tool_args_json AS toolArgsJson,
			emb.tool_input AS toolInput,
			emb.payload_json AS payloadJson
		FROM entry_message_blocks emb
		WHERE emb.rowid IN (${selectedEntryRowIdsSql("entry_message_blocks", "AND selected.type != 'image'")})
		ORDER BY emb.rowid ASC
	`).all(sessionId)
	const imageBlockRows = db.prepare(`
		SELECT emb.global_id AS globalId, ${MESSAGE_BLOCK_COLUMNS_SQL}
		FROM entry_message_blocks emb
		LEFT JOIN session_attachments sa ON sa.id = emb.image_attachment_id
		LEFT JOIN session_attachment_variants sav ON sav.attachment_id = emb.image_attachment_id AND sav.variant = 'display'
		LEFT JOIN session_attachment_variants saov ON saov.attachment_id = emb.image_attachment_id AND saov.variant = 'original'
		WHERE emb.rowid IN (${selectedEntryRowIdsSql("entry_message_blocks", "AND selected.type = 'image'")})
		ORDER BY emb.rowid ASC
	`).all(sessionId)
	const messageBlocks = groupedRowsByGlobalId([...commonBlockRows, ...imageBlockRows])
	messageBlocks.forEach((blocks) => blocks.sort((a, b) => a.ordinal - b.ordinal))
	const usage = rowsByGlobalId(db.prepare(`
		SELECT ${USAGE_COLUMNS_SQL}
		FROM entry_usage eu
		WHERE eu.rowid IN (${selectedEntryRowIdsSql("entry_usage")})
		ORDER BY eu.rowid ASC
	`).all(sessionId))
	const labels = rowsByGlobalId(db.prepare(`
		SELECT el.global_id AS globalId, target.id AS targetId, el.label
		FROM entry_labels el
		JOIN conversation_entries target ON target.global_id = el.target_global_id
		WHERE el.rowid IN (${selectedEntryRowIdsSql("entry_labels")})
		ORDER BY el.rowid ASC
	`).all(sessionId))
	const customEntries = rowsByGlobalId(db.prepare(`
		SELECT ece.global_id AS globalId, ece.custom_type AS customType, ${CUSTOM_ENTRY_DATA_COLUMNS_SQL}
		FROM entry_custom_entries ece
		WHERE ece.rowid IN (${selectedEntryRowIdsSql("entry_custom_entries")})
		ORDER BY ece.rowid ASC
	`).all(sessionId))
	const contextLoads = rowsByGlobalId(db.prepare(`
		SELECT
			ecl.global_id AS globalId,
			ecl.source AS contextSource,
			ecl.cwd AS contextCwd,
			ecl.loaded_at AS contextLoadedAt,
			ecl.disabled AS contextDisabled
		FROM entry_context_loads ecl
		WHERE ecl.rowid IN (${selectedEntryRowIdsSql("entry_context_loads")})
		ORDER BY ecl.rowid ASC
	`).all(sessionId))
	const contextFiles = groupedRowsByGlobalId(db.prepare(`
		SELECT ecf.global_id AS globalId, ecf.ordinal, ecf.path, ecf.scope_dir AS scopeDir, ecf.identity_path AS identityPath, ecf.content, ecf.hash
		FROM entry_context_files ecf
		WHERE ecf.rowid IN (${selectedEntryRowIdsSql("entry_context_files")})
		ORDER BY ecf.rowid ASC
	`).all(sessionId))
	contextFiles.forEach((files) => files.sort((a, b) => a.ordinal - b.ordinal))
	const recoveryMessageStmt = db.prepare(`
		SELECT CASE WHEN json_valid(data_json) THEN json_extract(data_json, '$.message') END AS messageJson
		FROM entry_custom_entries
		WHERE global_id = ?
	`)
	const data = { messages, messageBlocks, usage, labels, customEntries, contextLoads, contextFiles, recoveryMessageStmt }
	const entryGlobalIds = new Map(rows.map((row) => [row.id, row.globalId]))
	return { entries: rows.map((row) => entryFromRows(row, data)), entryGlobalIds }
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

function toolExecutionDataFromRow(row, loadRecoveryMessage) {
	if (!row) return undefined
	if (row.dataJson !== null && row.dataJson !== undefined) return parseJson(row.dataJson)
	const data = {}
	withDefined(data, "version", row.customVersion)
	withDefined(data, "phase", row.customPhase)
	withDefined(data, "runId", row.customRunId)
	withDefined(data, "toolCallId", row.customToolCallId)
	withDefined(data, "toolName", row.customToolName)
	if (row.customIsError !== null && row.customIsError !== undefined) data.isError = intToBool(row.customIsError)
	withDefined(data, "messageEntryId", row.customMessageEntryId)
	if (row.customHasDurableMessage !== null && row.customHasDurableMessage !== undefined) data.hasDurableMessage = intToBool(row.customHasDurableMessage)
	if (row.customHasRecoveryMessage) {
		data.hasRecoveryMessage = true
		defineLazyJsonField(data, "message", loadRecoveryMessage)
	}
	return data
}

function contextLoadFromRow(row, files) {
	return {
		source: row.contextSource,
		...(row.contextCwd ? { cwd: row.contextCwd } : {}),
		loadedAt: row.contextLoadedAt,
		disabled: intToBool(row.contextDisabled),
		files,
	}
}

function entryFromRows(row, data) {
	const base = { id: row.id, parentId: row.parentId ?? null, timestamp: row.entryTimestamp }
	const contextRow = data.contextLoads.get(row.globalId)
	const contextLoad = contextRow ? contextLoadFromRow(contextRow, data.contextFiles.get(row.globalId) ?? []) : undefined
	const withContextLoad = (entry) => contextLoad ? { ...entry, contextLoad } : entry
	if (row.entryType === "message") {
		return withContextLoad({
			...base,
			type: "message",
			message: messageFromRow(data.messages.get(row.globalId), data.messageBlocks.get(row.globalId) ?? [], data.usage.get(row.globalId)),
		})
	}
	if (row.entryType === "label") {
		const label = data.labels.get(row.globalId)
		return withContextLoad({ ...base, type: "label", targetId: label?.targetId, label: label?.label ?? undefined })
	}
	if (row.entryType === "custom") {
		const custom = data.customEntries.get(row.globalId)
		const customType = custom?.customType ?? "unknown"
		const loadRecoveryMessage = () => data.recoveryMessageStmt.get(row.globalId)?.messageJson
		const customData = normalizeLegacyEntryData(customType === "tool_execution"
			? toolExecutionDataFromRow(custom, loadRecoveryMessage)
			: parseJson(custom?.dataJson))
		return withContextLoad({ ...base, type: "custom", customType, data: customData })
	}
	if (row.entryType === "context") return { ...base, type: "context", contextLoad: contextLoad ?? { source: "unknown", files: [] } }
	throw new Error(`Unsupported session entry kind in database: ${row.entryType}`)
}

function messageFromRow(row, blockRows, usageRow) {
	if (!row) return { role: "unknown", content: [] }
	const blocks = blockRows.map(deserializeBlock)
	const content = row.contentFormat === "string" ? (blocks[0]?.text ?? "") : blocks
	const usage = usageFromRow(usageRow)
	const extra = normalizeLegacyMetadata(parseJson(row.extraJson, {}) ?? {})
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

function usageFromRow(row) {
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

export function loadMessage(db, globalId) {
	const row = db.prepare(`
		SELECT ${MESSAGE_COLUMNS_SQL}
		FROM entry_messages em
		WHERE em.global_id = ?
	`).get(globalId)
	const blockRows = db.prepare(`
		SELECT ${MESSAGE_BLOCK_COLUMNS_SQL}
		FROM entry_message_blocks emb
		LEFT JOIN session_attachments sa ON sa.id = emb.image_attachment_id
		LEFT JOIN session_attachment_variants sav ON sav.attachment_id = emb.image_attachment_id AND sav.variant = 'display'
		LEFT JOIN session_attachment_variants saov ON saov.attachment_id = emb.image_attachment_id AND saov.variant = 'original'
		WHERE emb.global_id = ?
		ORDER BY emb.ordinal ASC
	`).all(globalId)
	const usageRow = db.prepare(`
		SELECT ${USAGE_COLUMNS_SQL}
		FROM entry_usage eu
		WHERE eu.global_id = ?
	`).get(globalId)
	return messageFromRow(row, blockRows, usageRow)
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
			INSERT INTO entry_context_files (global_id, ordinal, path, scope_dir, identity_path, content, hash)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`).run(globalId, ordinal, file.path, file.scopeDir ?? null, file.identityPath ?? null, file.content ?? "", file.hash ?? null)
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
			image_attachment_id,
			image_number,
			image_attachment_session_id,
			image_original_data,
			image_original_mime_type,
			image_original_width_px,
			image_original_height_px,
			tool_call_id,
			tool_name,
			tool_args_json,
			tool_input,
			payload_json
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
		row.imageAttachmentId ?? null,
		row.imageNumber ?? null,
		row.imageAttachmentSessionId ?? null,
		row.imageOriginalData ?? null,
		row.imageOriginalMimeType ?? null,
		row.imageOriginalWidthPx ?? null,
		row.imageOriginalHeightPx ?? null,
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
