import {
	BASH_SHORTCUT_CUSTOM_TYPE,
	BASH_SHORTCUT_MESSAGE_ROLE,
	bashShortcutOverviewMessageForEntry,
} from "./bash-shortcut-entry.js"
import { normalizeLegacyMessage } from "./metadata-compatibility.js"

const SESSION_OVERVIEW_BATCH_SIZE = 200

export const HIDDEN_MESSAGE_EXTRA_SQL = `
	em.extra_json IS NOT NULL
	AND json_valid(em.extra_json)
	AND (
		COALESCE(json_extract(em.extra_json, '$.automated'), json_extract(em.extra_json, '$.pinanoAutomated'), 0) = 1
		OR COALESCE(json_extract(em.extra_json, '$.hidden'), json_extract(em.extra_json, '$.pinanoHidden'), 0) = 1
		OR COALESCE(json_extract(em.extra_json, '$.compactionMemento'), json_extract(em.extra_json, '$.pinanoCompactionMemento'), 0) = 1
		OR COALESCE(json_extract(em.extra_json, '$.compactionSummary'), json_extract(em.extra_json, '$.pinanoCompactionSummary'), 0) = 1
		OR COALESCE(json_type(em.extra_json, '$.maintenance'), json_type(em.extra_json, '$.pinanoMaintenance')) IS NOT NULL
	)
`

export const PROJECT_CONTEXT_EXTRA_SQL = `
	em.role = 'user'
	AND em.extra_json IS NOT NULL
	AND json_valid(em.extra_json)
	AND COALESCE(json_extract(em.extra_json, '$.projectContext'), 0) = 1
`

function nowIso() {
	return new Date().toISOString()
}

function hasOwn(object, key) {
	return Object.prototype.hasOwnProperty.call(object ?? {}, key)
}

function flagSet(value) {
	return value === true || value === 1
}

export function visibleOverviewMessage(message) {
	message = normalizeLegacyMessage(message)
	if (!message) return undefined
	if (flagSet(message.automated)) return undefined
	if (flagSet(message.hidden)) return undefined
	if (flagSet(message.compactionMemento)) return undefined
	if (flagSet(message.compactionSummary)) return undefined
	if (hasOwn(message, "maintenance")) return undefined
	if (message.role === "user" && flagSet(message.projectContext)) return undefined
	return message
}

export function flattenOverviewContent(content) {
	if (typeof content === "string") return content.trim()
	if (!Array.isArray(content)) return ""
	return content
		.filter((block) => block?.type === "text")
		.map((block) => block.text ?? "")
		.join(" ")
		.trim()
}

export function previewMessageFromRow(row) {
	let blocks = []
	try {
		blocks = JSON.parse(row.blocksJson || "[]")
	} catch {}
	const content = row.contentFormat === "string"
		? (blocks.find((block) => block?.type === "text")?.text ?? "")
		: blocks.map((block) => {
			if (block?.type === "text") return { type: "text", text: block.text ?? "" }
			if (block?.payloadJson) {
				try { return JSON.parse(block.payloadJson) } catch {}
			}
			return { type: block?.type ?? "unknown" }
		})
	return {
		sessionId: row.sessionId,
		previewKind: row.previewKind,
		entryId: row.entryId,
		timestamp: row.timestamp,
		role: row.role,
		content,
	}
}

export function cachedPreviewRowsFromOverview(row) {
	const rows = []
	if (row.firstEntryId) {
		rows.push({
			sessionId: row.sessionId,
			previewKind: "first",
			entryId: row.firstEntryId,
			timestamp: row.firstTimestamp,
			role: row.firstRole ?? "?",
			content: row.firstText ?? "",
		})
	}
	if (row.lastUserEntryId) {
		rows.push({
			sessionId: row.sessionId,
			previewKind: "lastUser",
			entryId: row.lastUserEntryId,
			timestamp: row.lastUserTimestamp,
			role: "user",
			content: row.lastUserText ?? "",
		})
	}
	return rows
}

// For active ancestors, session_entries.seq is root-to-leaf order because parents are stored before children. Use it to choose the two preview target entries before loading message blocks.
export function previewMessagesForSelectedSql(selectedValuesSql) {
	return `
		WITH RECURSIVE
			selected(ord, session_id) AS (
				VALUES ${selectedValuesSql}
			),
			leaf(ord, session_id, entry_id) AS (
				SELECT selected.ord, selected.session_id, COALESCE(
					(
						SELECT se.entry_id
						FROM session_entries se
						WHERE se.session_id = selected.session_id AND se.entry_id = s.active_leaf_entry_id
						LIMIT 1
					),
					(
						SELECT se.entry_id
						FROM session_entries se
						WHERE se.session_id = selected.session_id
						ORDER BY se.seq DESC
						LIMIT 1
					)
				)
				FROM selected
				JOIN sessions s ON s.id = selected.session_id AND s.deleted_at IS NULL
			),
			ancestors(ord, session_id, entry_id, parent_entry_id) AS (
				SELECT leaf.ord, leaf.session_id, se.entry_id, se.parent_entry_id
				FROM leaf
				JOIN session_entries se ON se.session_id = leaf.session_id AND se.entry_id = leaf.entry_id
				UNION ALL
				SELECT ancestors.ord, ancestors.session_id, parent.entry_id, parent.parent_entry_id
				FROM ancestors
				JOIN session_entries parent
					ON parent.session_id = ancestors.session_id
					AND parent.entry_id = ancestors.parent_entry_id
			),
			visible_entries AS (
				SELECT
					ancestors.ord AS ord,
					ancestors.session_id AS sessionId,
					se.global_id AS globalId,
					se.entry_id AS entryId,
					se.timestamp AS timestamp,
					se.seq AS seq,
					em.role AS role
				FROM ancestors
				JOIN session_entries se ON se.session_id = ancestors.session_id AND se.entry_id = ancestors.entry_id
				JOIN entry_messages em ON em.global_id = se.global_id
				WHERE NOT (${HIDDEN_MESSAGE_EXTRA_SQL})
					AND NOT (${PROJECT_CONTEXT_EXTRA_SQL})
				UNION ALL
				SELECT
					ancestors.ord AS ord,
					ancestors.session_id AS sessionId,
					se.global_id AS globalId,
					se.entry_id AS entryId,
					se.timestamp AS timestamp,
					se.seq AS seq,
					'${BASH_SHORTCUT_MESSAGE_ROLE}' AS role
				FROM ancestors
				JOIN session_entries se ON se.session_id = ancestors.session_id AND se.entry_id = ancestors.entry_id
				JOIN entry_custom_entries ece ON ece.global_id = se.global_id
				WHERE ece.custom_type = '${BASH_SHORTCUT_CUSTOM_TYPE}'
			),
			preview_seqs AS (
				SELECT
					ord,
					sessionId,
					min(seq) AS firstSeq,
					max(CASE WHEN role = 'user' THEN seq END) AS lastUserSeq
				FROM visible_entries
				GROUP BY ord, sessionId
			),
			preview_targets AS (
				SELECT
					0 AS previewOrder,
					'first' AS previewKind,
					visible_entries.ord AS ord,
					visible_entries.sessionId AS sessionId,
					visible_entries.globalId AS globalId,
					visible_entries.entryId AS entryId,
					visible_entries.timestamp AS timestamp
				FROM preview_seqs
				JOIN visible_entries ON visible_entries.ord = preview_seqs.ord
					AND visible_entries.sessionId = preview_seqs.sessionId
					AND visible_entries.seq = preview_seqs.firstSeq
				WHERE preview_seqs.firstSeq IS NOT NULL
				UNION ALL
				SELECT
					1 AS previewOrder,
					'lastUser' AS previewKind,
					visible_entries.ord AS ord,
					visible_entries.sessionId AS sessionId,
					visible_entries.globalId AS globalId,
					visible_entries.entryId AS entryId,
					visible_entries.timestamp AS timestamp
				FROM preview_seqs
				JOIN visible_entries ON visible_entries.ord = preview_seqs.ord
					AND visible_entries.sessionId = preview_seqs.sessionId
					AND visible_entries.seq = preview_seqs.lastUserSeq
				WHERE preview_seqs.lastUserSeq IS NOT NULL
			)
		SELECT
			preview_targets.previewKind,
			preview_targets.sessionId,
			preview_targets.entryId AS entryId,
			preview_targets.timestamp AS timestamp,
			COALESCE(em.role, CASE WHEN ece.custom_type = '${BASH_SHORTCUT_CUSTOM_TYPE}' THEN '${BASH_SHORTCUT_MESSAGE_ROLE}' END) AS role,
			CASE WHEN ece.custom_type = '${BASH_SHORTCUT_CUSTOM_TYPE}' THEN 'array' ELSE em.content_format END AS contentFormat,
			CASE WHEN ece.custom_type = '${BASH_SHORTCUT_CUSTOM_TYPE}' THEN
				json_array(json_object(
					'type', 'text',
					'text', '$ ' || COALESCE(json_extract(ece.data_json, '$.command'), '') || CASE WHEN COALESCE(json_extract(ece.data_json, '$.excludeFromContext'), 0) THEN ' (no-ctx)' ELSE '' END
				))
			ELSE (
				SELECT json_group_array(json_object(
					'type', mb.type,
					'text', mb.text,
					'payloadJson', mb.payload_json
				))
				FROM (
					SELECT type, text, payload_json
					FROM entry_message_blocks
					WHERE global_id = preview_targets.globalId
					ORDER BY ordinal ASC
				) mb
			) END AS blocksJson
		FROM preview_targets
		LEFT JOIN entry_messages em ON em.global_id = preview_targets.globalId
		LEFT JOIN entry_custom_entries ece ON ece.global_id = preview_targets.globalId AND ece.custom_type = '${BASH_SHORTCUT_CUSTOM_TYPE}'
		WHERE em.global_id IS NOT NULL OR ece.global_id IS NOT NULL
		ORDER BY preview_targets.ord ASC, preview_targets.previewOrder ASC
	`
}

function loadPreviewMessagesForSessionBatch(db, ids) {
	if (ids.length === 0) return []
	const values = ids.map((_, i) => `(${i}, ?)`).join(", ")
	const stmt = db.prepare(previewMessagesForSelectedSql(values))
	return stmt.all(...ids).map(previewMessageFromRow)
}

function loadPreviewMessagesForSessions(db, ids) {
	return ids.flatMap((_, i) => i % SESSION_OVERVIEW_BATCH_SIZE === 0
		? loadPreviewMessagesForSessionBatch(db, ids.slice(i, i + SESSION_OVERVIEW_BATCH_SIZE))
		: [])
}

function overviewLeavesForSessionBatch(db, ids) {
	if (ids.length === 0) return []
	const values = ids.map(() => "(?)").join(", ")
	const stmt = db.prepare(`
		WITH selected(session_id) AS (
			VALUES ${values}
		)
		SELECT
			selected.session_id AS sessionId,
			COALESCE(
				(
					SELECT se.entry_id
					FROM session_entries se
					WHERE se.session_id = selected.session_id AND se.entry_id = s.active_leaf_entry_id
					LIMIT 1
				),
				(
					SELECT se.entry_id
					FROM session_entries se
					WHERE se.session_id = selected.session_id
					ORDER BY se.seq DESC
					LIMIT 1
				)
			) AS activeLeafEntryId
		FROM selected
		JOIN sessions s ON s.id = selected.session_id AND s.deleted_at IS NULL
	`)
	return stmt.all(...ids)
}

function overviewLeavesForSessions(db, ids) {
	return ids.flatMap((_, i) => i % SESSION_OVERVIEW_BATCH_SIZE === 0
		? overviewLeavesForSessionBatch(db, ids.slice(i, i + SESSION_OVERVIEW_BATCH_SIZE))
		: [])
}

const overviewColumns = `
	session_id,
	active_leaf_entry_id,
	first_entry_id,
	first_timestamp,
	first_role,
	first_text,
	last_user_entry_id,
	last_user_timestamp,
	last_user_text,
	computed_at
`

function upsertSessionOverview(db, overview) {
	db.prepare(`
		INSERT INTO session_overviews (${overviewColumns})
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(session_id) DO UPDATE SET
			active_leaf_entry_id = excluded.active_leaf_entry_id,
			first_entry_id = excluded.first_entry_id,
			first_timestamp = excluded.first_timestamp,
			first_role = excluded.first_role,
			first_text = excluded.first_text,
			last_user_entry_id = excluded.last_user_entry_id,
			last_user_timestamp = excluded.last_user_timestamp,
			last_user_text = excluded.last_user_text,
			computed_at = excluded.computed_at
	`).run(
		overview.sessionId,
		overview.activeLeafEntryId ?? null,
		overview.firstEntryId ?? null,
		overview.firstTimestamp ?? null,
		overview.firstRole ?? null,
		overview.firstText ?? null,
		overview.lastUserEntryId ?? null,
		overview.lastUserTimestamp ?? null,
		overview.lastUserText ?? null,
		overview.computedAt ?? nowIso(),
	)
	return {
		sessionId: overview.sessionId,
		activeLeafEntryId: overview.activeLeafEntryId ?? null,
		firstEntryId: overview.firstEntryId ?? null,
		firstTimestamp: overview.firstTimestamp ?? null,
		firstRole: overview.firstRole ?? null,
		firstText: overview.firstText ?? null,
		lastUserEntryId: overview.lastUserEntryId ?? null,
		lastUserTimestamp: overview.lastUserTimestamp ?? null,
		lastUserText: overview.lastUserText ?? null,
	}
}

function overviewFromPreviewMessages(sessionId, activeLeafEntryId, messages) {
	const first = messages.find((row) => row.previewKind === "first")
	const lastUser = messages.find((row) => row.previewKind === "lastUser")
	return {
		sessionId,
		activeLeafEntryId: activeLeafEntryId ?? null,
		firstEntryId: first?.entryId ?? null,
		firstTimestamp: first?.timestamp ?? null,
		firstRole: first?.role ?? null,
		firstText: first ? flattenOverviewContent(first.content) : null,
		lastUserEntryId: lastUser?.entryId ?? null,
		lastUserTimestamp: lastUser?.timestamp ?? null,
		lastUserText: lastUser ? flattenOverviewContent(lastUser.content) : null,
		computedAt: nowIso(),
	}
}

export function ensureSessionOverviewProjection(db, sessionId, activeLeafEntryId = null) {
	db.prepare(`
		INSERT OR IGNORE INTO session_overviews (${overviewColumns})
		VALUES (?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?)
	`).run(sessionId, activeLeafEntryId ?? null, nowIso())
}

export function updateSessionOverviewForAppendedEntry(db, sessionId, entry, activeLeafEntryId) {
	const current = db.prepare("SELECT session_id AS sessionId FROM session_overviews WHERE session_id = ?").get(sessionId)
	if (!current) {
		return recomputeSessionOverviewProjections(db, [sessionId])[0]
	}
	const message = entry.type === "message"
		? visibleOverviewMessage(entry.message)
		: bashShortcutOverviewMessageForEntry(entry)
	const computedAt = nowIso()
	if (!message) {
		db.prepare(`
			UPDATE session_overviews
			SET active_leaf_entry_id = ?,
				computed_at = ?
			WHERE session_id = ?
		`).run(activeLeafEntryId ?? null, computedAt, sessionId)
		return current
	}
	const text = flattenOverviewContent(message.content)
	const isUser = message.role === "user" ? 1 : 0
	db.prepare(`
		UPDATE session_overviews
		SET active_leaf_entry_id = ?,
			first_entry_id = COALESCE(first_entry_id, ?),
			first_timestamp = CASE WHEN first_entry_id IS NULL THEN ? ELSE first_timestamp END,
			first_role = CASE WHEN first_entry_id IS NULL THEN ? ELSE first_role END,
			first_text = CASE WHEN first_entry_id IS NULL THEN ? ELSE first_text END,
			last_user_entry_id = CASE WHEN ? THEN ? ELSE last_user_entry_id END,
			last_user_timestamp = CASE WHEN ? THEN ? ELSE last_user_timestamp END,
			last_user_text = CASE WHEN ? THEN ? ELSE last_user_text END,
			computed_at = ?
		WHERE session_id = ?
	`).run(
		activeLeafEntryId ?? null,
		entry.id,
		entry.timestamp ?? null,
		message.role ?? null,
		text,
		isUser,
		isUser ? entry.id : null,
		isUser,
		isUser ? entry.timestamp ?? null : null,
		isUser,
		isUser ? text : null,
		computedAt,
		sessionId,
	)
	return current
}

export function recomputeSessionOverviewProjections(db, ids) {
	const uniqueIds = [...new Set(ids.filter(Boolean))]
	if (uniqueIds.length === 0) return []
	const leaves = overviewLeavesForSessions(db, uniqueIds)
	const sessionIds = leaves.map((row) => row.sessionId)
	const messagesBySessionId = new Map()
	for (const row of loadPreviewMessagesForSessions(db, sessionIds)) {
		const messages = messagesBySessionId.get(row.sessionId) ?? []
		messages.push(row)
		messagesBySessionId.set(row.sessionId, messages)
	}
	return leaves.map((leaf) => upsertSessionOverview(
		db,
		overviewFromPreviewMessages(
			leaf.sessionId,
			leaf.activeLeafEntryId ?? null,
			messagesBySessionId.get(leaf.sessionId) ?? [],
		),
	))
}

export function recomputeAllSessionOverviewProjections(db) {
	const rows = db.prepare("SELECT id FROM sessions WHERE deleted_at IS NULL").all()
	return recomputeSessionOverviewProjections(db, rows.map((row) => row.id))
}
