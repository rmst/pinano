// SQLite database for Pinano server/web mode.
//
// This is the canonical store for sessions, transcript/tree entries, run
// records, service lifecycle rows, and server/client coordination. Keep schema
// changes as explicit migrations using PRAGMA user_version, matching the
// pattern used in our other apps.

import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { dirname, sep } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { promptImageLabel } from "../../../../protocol/src/prompt-images.js"
import { serverDbPath } from "../paths.js"
import {
	SESSION_ATTACHMENT_KIND_IMAGE,
	SESSION_ATTACHMENT_VARIANT_DISPLAY,
	SESSION_ATTACHMENT_VARIANT_ORIGINAL,
	writePromptImageAttachmentFilesSync,
} from "../session-attachments.js"
import {
	cachedPreviewRowsFromOverview,
	previewMessageFromRow,
	previewMessagesForSelectedSql,
	recomputeSessionOverviewProjections,
} from "../../session-manager/session-overviews.js"

import {
	attachmentImageBlockFromRows,
	attachmentSelectSql,
	insertSessionAttachmentRows,
	nextImageAttachmentNumber,
} from "./attachments.js"
import {
	migrateServerDb,
	SESSION_KIND_NORMAL,
	SESSION_KIND_PROJECT_MAINTENANCE,
} from "./schema.js"
import { nowIso, parseJson } from "./values.js"

export { SCHEMA_VERSION, SESSION_KIND_NORMAL, SESSION_KIND_PROJECT_MAINTENANCE } from "./schema.js"

const SERVER_DB_CACHE_SIZE_KIB = 128 * 1024
const SESSION_PREVIEW_BATCH_SIZE = 200

/**
 * @typedef {object} ServerDbSession
 * @property {string} id
 * @property {string} cwd
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string | undefined} [deletedAt]
 * @property {string | undefined} [latestRunStartedAt]
 * @property {string | undefined} [latestRunEndedAt]
 * @property {string | undefined} [latestRunError]
 * @property {string | undefined} [latestRunStopReason]
 * @property {"running" | "idle" | "failed" | "aborted" | "interrupted" | undefined} [runStatus]
 * @property {"running" | "idle" | "failed" | "aborted" | "interrupted" | "paused" | undefined} [runtimeState]
 * @property {"not_started" | "running" | "stopped" | string | undefined} [lifecycleState]
 * @property {{ state?: "working" | "needs_input" | "ready_for_review" | "discussing" | "deferred" | "completed" | "experiencing_problems" | string, descriptionInUi?: string, description?: string, projectTag?: string, needsInput?: string, result?: string, updatedAt?: string } | undefined} [agentView]
 * @property {string | undefined} [projectDir]
 * @property {string | undefined} [initialWd]
 * @property {boolean} [hidden]
 * @property {boolean} [hasWorktrees]
 * @property {string | undefined} [sessionKind]
 * @property {SubSessionRow} [subSession]
 */

/**
 * @typedef {object} SubSessionRow
 * @property {string} childSessionId
 * @property {string} parentSessionId
 * @property {string} rootSessionId
 * @property {string} name
 * @property {string} origin
 * @property {string} forkTurns
 * @property {number} depth
 * @property {string | undefined} [task]
 * @property {string | undefined} [branchEntryId]
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string | undefined} [closedAt]
 * @property {string | undefined} [closeReason]
 */

/**
 * @typedef {object} ProjectMaintenanceSessionRow
 * @property {string} projectDir
 * @property {string} sessionId
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {object} PreviewRootCacheRow
 * @property {string} scopeId
 * @property {string} scopeKind
 * @property {string} rootPath
 * @property {string | undefined} [projectDir]
 * @property {string | undefined} [sessionId]
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {object} ServerDb
 * @property {import("node:sqlite").DatabaseSync} raw
 * @property {(session: { id: string, cwd: string, initialWd?: string, createdAt?: string, updatedAt?: string }) => void} upsertSession
 * @property {(id: string, cwd?: string, updatedAt?: string) => void} touchSession
 * @property {(id: string) => void} markSessionDeleted
 * @property {(id: string) => boolean} restoreSession
 * @property {(id: string, hidden?: boolean) => void} setSessionHidden
 * @property {(id: string, state: string) => void} setSessionRuntimeState
 * @property {(id: string, metadata: { state?: string, descriptionInUi?: string, description?: string, projectTag?: string, needsInput?: string, result?: string, updatedAt?: string }) => void} setAgentViewMetadata
 * @property {(id: string, projectDir?: string | null) => void} setSessionProjectDir
 * @property {(id: string) => { state?: string, descriptionInUi?: string, description?: string, projectTag?: string, needsInput?: string, result?: string, updatedAt?: string } | undefined} getAgentViewMetadata
 * @property {(id: string) => { mutationVersion: number, mutationRunId?: string, runtimeState?: string, agentViewState?: string } | undefined} getSessionMutation
 * @property {(id: string) => PromptDraft} getPromptDraft
 * @property {(id: string, text: string, options?: { clientId?: string, clientSeq?: number }) => PromptDraft} setPromptDraft
 * @property {(key: string) => any | undefined} getUiState
 * @property {(key: string, value: any) => any} setUiState
 * @property {(key: string) => boolean} deleteUiState
 * @property {(sessionId: string, images: any[], options?: { minimumNumber?: number }) => any[]} createPromptImageAttachments
 * @property {(id: string) => any | undefined} getImageAttachment
 * @property {(sessionId: string, number: number) => any | undefined} getImageAttachmentByNumber
 * @property {(sessionId: string, attachmentId: string, variant?: string) => ({ data: Buffer, mimeType: string, filename?: string } & Record<string, any>) | undefined} getAttachmentVariant
 * @property {(id: string, options?: { includeDeleted?: boolean }) => ServerDbSession | undefined} getSession
 * @property {(id: string, options?: { includeHidden?: boolean, includeDeleted?: boolean }) => ServerDbSession | undefined} getSessionListEntry
 * @property {(cwd?: string, options?: { includeHidden?: boolean, includeDeleted?: boolean }) => ServerDbSession[]} listSessions
 * @property {(cwd: string, options?: { includeHidden?: boolean, includeDeleted?: boolean }) => ServerDbSession[]} listSessionsForDirectory
 * @property {(options?: { cwd?: string, includeHidden?: boolean, includeDeleted?: boolean }) => ServerDbSession[]} listSessionStatuses
 * @property {(sessionId: string, customType: string) => Array<{ id: string, parentId: string | null, timestamp: string, type: "custom", customType: string, data: any }>} loadSessionCustomEntries
 * @property {(record: { projectDir: string, sessionId: string }) => ProjectMaintenanceSessionRow | undefined} markProjectMaintenanceSession
 * @property {(projectDir: string) => ProjectMaintenanceSessionRow | undefined} getProjectMaintenanceSession
 * @property {(sessionId: string) => ProjectMaintenanceSessionRow | undefined} getProjectMaintenanceSessionBySessionId
 * @property {() => ProjectMaintenanceSessionRow[]} listProjectMaintenanceSessions
 * @property {(record: { scopeId: string, scopeKind: string, rootPath: string, projectDir?: string | null, sessionId?: string | null, createdAt?: string, updatedAt?: string }) => PreviewRootCacheRow} upsertPreviewRoot
 * @property {(scopeId: string) => PreviewRootCacheRow | undefined} getPreviewRoot
 * @property {(scopeKind?: string) => PreviewRootCacheRow[]} listPreviewRoots
 * @property {(record: { childSessionId: string, parentSessionId: string, rootSessionId: string, name: string, origin: string, forkTurns: string, depth: number, task?: string, branchEntryId?: string, createdAt?: string, updatedAt?: string }) => SubSessionRow} upsertSubSession
 * @property {(childSessionId: string, closeReason?: string, closedAt?: string) => SubSessionRow | undefined} closeSubSession
 * @property {(childSessionId: string, updatedAt?: string) => SubSessionRow | undefined} reopenSubSession
 * @property {(childSessionId: string) => SubSessionRow | undefined} getSubSession
 * @property {(parentSessionId: string, options?: { includeClosed?: boolean }) => SubSessionRow[]} listSubSessions
 * @property {(rootSessionId: string, options?: { includeClosed?: boolean }) => SubSessionRow[]} listSubSessionsForRoot
 * @property {(id: string) => Array<{ previewKind: "first" | "lastUser", entryId: string, timestamp: string, role: string, content: string | any[] }>} loadSessionPreviewMessages
 * @property {(ids: string[]) => Array<{ sessionId: string, previewKind: "first" | "lastUser", entryId: string, timestamp: string, role: string, content: string | any[] }>} loadSessionPreviewMessagesForSessions
 * @property {(ids: string[]) => Array<{ sessionId: string, previewKind: "first" | "lastUser", entryId: string, timestamp: string, role: string, content: string }>} loadSessionOverviewPreviewMessagesForSessions
 * @property {(ids: string[]) => Array<{ sessionId: string, activeLeafEntryId: string | null, firstEntryId: string | null, firstTimestamp: string | null, firstRole: string | null, firstText: string | null, lastUserEntryId: string | null, lastUserTimestamp: string | null, lastUserText: string | null }>} refreshSessionOverviewsForSessions
 * @property {(cwd: string) => string | undefined} latestSessionForCwd
 * @property {(prefix: string) => string[]} findSessionIdsByPrefix
 * @property {(sessions: Array<{ id: string, cwd: string, initialWd?: string, createdAt?: string, updatedAt?: string }>) => void} replaceSessions
 * @property {() => number} sessionCount
 * @property {(run: { id: string, sessionId: string, startedAt?: string, expectedMutationVersion: number }) => void} startRun
 * @property {(id: string, update: { status: string, error?: string, stopReason?: string, endedAt?: string }) => void} finishRun
 * @property {(sessionId: string, update: { status: string, error?: string, stopReason?: string, endedAt?: string }) => boolean} finishLatestInterruptedRunForSession
 * @property {() => number} interruptRunningRuns
 * @property {(run: { id: string, pid?: number, cwd: string, transport?: string, port?: number, codeFingerprint?: string, startedAt?: string }) => void} startServiceRun
 * @property {(id: string, update: { status: string, endedAt?: string, exitCode?: number | null, signal?: string | null, reason?: string }) => void} finishServiceRun
 * @property {(reason?: string, exceptId?: string) => number} recoverServiceRuns
 * @property {(limit?: number) => any[]} listServiceRuns
 * @property {() => void} close
 */

/** @typedef {{ text: string, version: number, updatedAt?: string, updatedByClientId?: string, updatedByClientSeq?: number, applied?: boolean }} PromptDraft */

/** @param {string | undefined} tag */
function normalizeProjectTag(tag) {
	const words = String(tag || "").replace(/\s+/g, " ").trim().toLowerCase().split(" ").filter(Boolean).slice(0, 3)
	return words.join(" ").slice(0, 40) || null
}

/** @param {string} status */
function normalizeRunStatus(status) {
	if (status === "running") return "running"
	if (status === "failed") return "failed"
	if (status === "aborted") return "aborted"
	if (status === "interrupted") return "interrupted"
	return "idle"
}

function sessionFromRow(row) {
	if (!row) return undefined
	return {
		id: row.id,
		cwd: row.cwd,
		initialWd: row.initialWd ?? undefined,
		projectDir: row.projectDir ?? undefined,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		deletedAt: row.deletedAt ?? undefined,
		hidden: row.hidden === 1,
		...(row.hasWorktrees === undefined ? {} : { hasWorktrees: row.hasWorktrees === 1 }),
		sessionKind: row.sessionKind ?? SESSION_KIND_NORMAL,
		latestRunStartedAt: row.latestRunStartedAt ?? undefined,
		latestRunEndedAt: row.latestRunEndedAt ?? undefined,
		latestRunError: row.latestRunError ?? undefined,
		latestRunStopReason: row.latestRunStopReason ?? undefined,
		runStatus: normalizeRunStatus(row.latestRunStatus),
		runtimeState: row.runtimeState ?? undefined,
		agentView: row.agentViewState || row.agentViewDescription || row.agentViewProjectTag || row.agentViewNeedsInput || row.agentViewResult ? {
			state: row.agentViewState ?? undefined,
			descriptionInUi: row.agentViewDescription ?? undefined,
			description: row.agentViewDescription ?? undefined,
			projectTag: row.agentViewProjectTag ?? undefined,
			needsInput: row.agentViewNeedsInput ?? undefined,
			result: row.agentViewResult ?? undefined,
			updatedAt: row.agentViewUpdatedAt ?? undefined,
		} : undefined,
	}
}

function mutationError(message, code) {
	const err = new Error(message)
	err.code = code
	return err
}

function promptDraftFromRow(row, overrides = {}) {
	return {
		text: row?.text ?? "",
		version: Number(row?.version ?? 0),
		updatedAt: row?.updatedAt ?? undefined,
		updatedByClientId: row?.updatedByClientId ?? undefined,
		updatedByClientSeq: row?.updatedByClientSeq ?? undefined,
		...overrides,
	}
}

function subSessionFromRow(row) {
	if (!row) return undefined
	return {
		childSessionId: row.childSessionId,
		parentSessionId: row.parentSessionId,
		rootSessionId: row.rootSessionId,
		name: row.name,
		origin: row.origin,
		forkTurns: row.forkTurns,
		depth: Number(row.depth ?? 0),
		task: row.task ?? undefined,
		branchEntryId: row.branchEntryId ?? undefined,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		closedAt: row.closedAt ?? undefined,
		closeReason: row.closeReason ?? undefined,
	}
}

function projectMaintenanceSessionFromRow(row) {
	if (!row) return undefined
	return {
		projectDir: row.projectDir,
		sessionId: row.sessionId,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	}
}

function previewRootCacheFromRow(row) {
	if (!row) return undefined
	return {
		scopeId: row.scopeId,
		scopeKind: row.scopeKind,
		rootPath: row.rootPath,
		projectDir: row.projectDir ?? undefined,
		sessionId: row.sessionId ?? undefined,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	}
}

/**
 * Open and migrate the Pinano server metadata db.
 * @param {{ path?: string, recoverRunningRuns?: boolean }} [options]
 * @returns {ServerDb}
 */
export function openServerDb(options = {}) {
	const path = options.path ?? serverDbPath()
	mkdirSync(dirname(path), { recursive: true })
	const db = new DatabaseSync(path)
	db.exec(`PRAGMA cache_size = -${SERVER_DB_CACHE_SIZE_KIB}`)
	db.exec("PRAGMA journal_mode = WAL")
	db.exec("PRAGMA busy_timeout = 1000")
	db.exec("PRAGMA foreign_keys = ON")
	migrateServerDb(db, { dbPath: path })

	// sessions.name is intentionally retained as an unused reserved column. Runtime code should not read or write it.
	const upsertSessionStmt = db.prepare(`
		INSERT INTO sessions (id, cwd, initial_wd, created_at, updated_at, deleted_at)
		VALUES (?, ?, ?, ?, ?, NULL)
		ON CONFLICT(id) DO UPDATE SET
			cwd = excluded.cwd,
			initial_wd = COALESCE(sessions.initial_wd, excluded.initial_wd),
			updated_at = excluded.updated_at,
			deleted_at = NULL
	`)
	const touchSessionStmt = db.prepare(`
		UPDATE sessions
		SET updated_at = COALESCE(?, updated_at), cwd = COALESCE(?, cwd), deleted_at = NULL
		WHERE id = ?
	`)
	const markDeletedStmt = db.prepare("UPDATE sessions SET deleted_at = ? WHERE id = ?")
	const restoreSessionStmt = db.prepare("UPDATE sessions SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL")
	const setSessionHiddenStmt = db.prepare("UPDATE sessions SET hidden = ? WHERE id = ? AND deleted_at IS NULL")
	const setRuntimeStateStmt = db.prepare("UPDATE sessions SET runtime_state = ?, runtime_state_updated_at = ? WHERE id = ? AND deleted_at IS NULL")
	const setSessionProjectDirStmt = db.prepare("UPDATE sessions SET project_dir = ? WHERE id = ? AND deleted_at IS NULL")
	const setAgentViewStmt = db.prepare(`
		UPDATE sessions
		SET agent_view_state = ?,
			agent_view_description = ?,
			agent_view_project_tag = ?,
			agent_view_needs_input = ?,
			agent_view_result = ?,
			agent_view_updated_at = ?
		WHERE id = ? AND deleted_at IS NULL
	`)
	const getAgentViewStmt = db.prepare(`
		SELECT
			agent_view_state AS state,
			agent_view_description AS description,
			agent_view_project_tag AS projectTag,
			agent_view_needs_input AS needsInput,
			agent_view_result AS result,
			agent_view_updated_at AS updatedAt
		FROM sessions
		WHERE id = ? AND deleted_at IS NULL
	`)
	const getPromptDraftStmt = db.prepare(`
		SELECT
			text,
			version,
			updated_at AS updatedAt,
			updated_by_client_id AS updatedByClientId,
			updated_by_client_seq AS updatedByClientSeq
		FROM session_prompt_drafts
		WHERE session_id = ?
	`)
	const currentPromptDraftVersionStmt = db.prepare("SELECT version FROM session_prompt_drafts WHERE session_id = ?")
	const getPromptDraftClientSeqStmt = db.prepare("SELECT last_seq AS lastSeq FROM session_prompt_draft_clients WHERE session_id = ? AND client_id = ?")
	const upsertPromptDraftClientSeqStmt = db.prepare(`
		INSERT INTO session_prompt_draft_clients (session_id, client_id, last_seq)
		VALUES (?, ?, ?)
		ON CONFLICT(session_id, client_id) DO UPDATE SET
			last_seq = MAX(session_prompt_draft_clients.last_seq, excluded.last_seq)
	`)
	const setPromptDraftStmt = db.prepare(`
		INSERT INTO session_prompt_drafts (session_id, text, version, updated_at, updated_by_client_id, updated_by_client_seq)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(session_id) DO UPDATE SET
			text = excluded.text,
			version = excluded.version,
			updated_at = excluded.updated_at,
			updated_by_client_id = excluded.updated_by_client_id,
			updated_by_client_seq = excluded.updated_by_client_seq
	`)
	const getUiStateStmt = db.prepare("SELECT value_json AS valueJson FROM ui_state WHERE state_key = ?")
	const setUiStateStmt = db.prepare(`
		INSERT INTO ui_state (state_key, value_json, updated_at)
		VALUES (?, ?, ?)
		ON CONFLICT(state_key) DO UPDATE SET
			value_json = excluded.value_json,
			updated_at = excluded.updated_at
	`)
	const deleteUiStateStmt = db.prepare("DELETE FROM ui_state WHERE state_key = ?")
	const getImageAttachmentByIdStmt = db.prepare(attachmentSelectSql("WHERE a.id = ? AND a.kind = ?"))
	const getImageAttachmentByNumberStmt = db.prepare(attachmentSelectSql(`
		JOIN (
			SELECT owned.id AS attachmentId, 0 AS rank
			FROM session_attachments owned
			WHERE owned.session_id = ? AND owned.kind = ? AND owned.number = ?
			UNION ALL
			SELECT mb.image_attachment_id AS attachmentId, 1 AS rank
			FROM session_entry_refs ser
			JOIN entry_message_blocks mb ON mb.global_id = ser.global_id
			WHERE ser.session_id = ?
				AND mb.type = 'image'
				AND mb.image_number = ?
				AND mb.image_attachment_id IS NOT NULL
		) visible ON visible.attachmentId = a.id
		WHERE a.kind = ?
		ORDER BY visible.rank ASC
		LIMIT 1
	`))
	const getAttachmentVariantStmt = db.prepare(`
		SELECT
			a.id,
			a.session_id AS sessionId,
			a.kind,
			a.number,
			v.variant,
			v.storage_backend AS storageBackend,
			v.storage_key AS storageKey,
			v.filename,
			v.file_path AS filePath,
			v.mime_type AS mimeType,
			v.byte_size AS byteSize,
			v.sha256,
			v.width_px AS widthPx,
			v.height_px AS heightPx
		FROM session_attachments a
		JOIN session_attachment_variants v ON v.attachment_id = a.id
		WHERE a.session_id = ?
			AND a.id = ?
			AND v.variant = ?
	`)
	const markProjectMaintenanceSessionStmt = db.prepare(`
		UPDATE sessions
		SET hidden = 1,
			session_kind = ?,
			project_dir = ?
		WHERE id = ? AND deleted_at IS NULL
		RETURNING
			project_dir AS projectDir,
			id AS sessionId,
			created_at AS createdAt,
			updated_at AS updatedAt
	`)
	const getProjectMaintenanceSessionStmt = db.prepare(`
		SELECT
			project_dir AS projectDir,
			id AS sessionId,
			created_at AS createdAt,
			updated_at AS updatedAt
		FROM sessions
		WHERE deleted_at IS NULL
			AND session_kind = ?
			AND project_dir = ?
	`)
	const getProjectMaintenanceSessionBySessionIdStmt = db.prepare(`
		SELECT
			project_dir AS projectDir,
			id AS sessionId,
			created_at AS createdAt,
			updated_at AS updatedAt
		FROM sessions
		WHERE deleted_at IS NULL
			AND session_kind = ?
			AND id = ?
	`)
	const listProjectMaintenanceSessionsStmt = db.prepare(`
		SELECT
			project_dir AS projectDir,
			id AS sessionId,
			created_at AS createdAt,
			updated_at AS updatedAt
		FROM sessions
		WHERE deleted_at IS NULL
			AND session_kind = ?
		ORDER BY updated_at DESC
	`)
	const upsertPreviewRootStmt = db.prepare(`
		INSERT INTO preview_root_cache (scope_id, scope_kind, root_path, project_dir, session_id, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(scope_id) DO UPDATE SET
			scope_kind = excluded.scope_kind,
			root_path = excluded.root_path,
			project_dir = excluded.project_dir,
			session_id = excluded.session_id,
			updated_at = excluded.updated_at
		RETURNING
			scope_id AS scopeId,
			scope_kind AS scopeKind,
			root_path AS rootPath,
			project_dir AS projectDir,
			session_id AS sessionId,
			created_at AS createdAt,
			updated_at AS updatedAt
	`)
	const getPreviewRootStmt = db.prepare(`
		SELECT
			scope_id AS scopeId,
			scope_kind AS scopeKind,
			root_path AS rootPath,
			project_dir AS projectDir,
			session_id AS sessionId,
			created_at AS createdAt,
			updated_at AS updatedAt
		FROM preview_root_cache
		WHERE scope_id = ?
	`)
	const listPreviewRootsStmt = db.prepare(`
		SELECT
			scope_id AS scopeId,
			scope_kind AS scopeKind,
			root_path AS rootPath,
			project_dir AS projectDir,
			session_id AS sessionId,
			created_at AS createdAt,
			updated_at AS updatedAt
		FROM preview_root_cache
		ORDER BY updated_at DESC
	`)
	const listPreviewRootsByKindStmt = db.prepare(`
		SELECT
			scope_id AS scopeId,
			scope_kind AS scopeKind,
			root_path AS rootPath,
			project_dir AS projectDir,
			session_id AS sessionId,
			created_at AS createdAt,
			updated_at AS updatedAt
		FROM preview_root_cache
		WHERE scope_kind = ?
		ORDER BY updated_at DESC
	`)
	const upsertSubSessionStmt = db.prepare(`
		INSERT INTO sub_sessions (
			child_session_id,
			parent_session_id,
			root_session_id,
			name,
			origin,
			fork_turns,
			depth,
			task,
			branch_entry_id,
			created_at,
			updated_at,
			closed_at,
			close_reason
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
		ON CONFLICT(child_session_id) DO UPDATE SET
			parent_session_id = excluded.parent_session_id,
			root_session_id = excluded.root_session_id,
			name = excluded.name,
			origin = excluded.origin,
			fork_turns = excluded.fork_turns,
			depth = excluded.depth,
			task = excluded.task,
			branch_entry_id = excluded.branch_entry_id,
			updated_at = excluded.updated_at
		RETURNING
			child_session_id AS childSessionId,
			parent_session_id AS parentSessionId,
			root_session_id AS rootSessionId,
			name,
			origin,
			fork_turns AS forkTurns,
			depth,
			task,
			branch_entry_id AS branchEntryId,
			created_at AS createdAt,
			updated_at AS updatedAt,
			closed_at AS closedAt,
			close_reason AS closeReason
	`)
	const closeSubSessionStmt = db.prepare(`
		UPDATE sub_sessions
		SET closed_at = COALESCE(closed_at, ?),
			close_reason = COALESCE(?, close_reason),
			updated_at = ?
		WHERE child_session_id = ?
		RETURNING
			child_session_id AS childSessionId,
			parent_session_id AS parentSessionId,
			root_session_id AS rootSessionId,
			name,
			origin,
			fork_turns AS forkTurns,
			depth,
			task,
			branch_entry_id AS branchEntryId,
			created_at AS createdAt,
			updated_at AS updatedAt,
			closed_at AS closedAt,
			close_reason AS closeReason
	`)
	const reopenSubSessionStmt = db.prepare(`
		UPDATE sub_sessions
		SET closed_at = NULL,
			close_reason = NULL,
			updated_at = ?
		WHERE child_session_id = ?
		RETURNING
			child_session_id AS childSessionId,
			parent_session_id AS parentSessionId,
			root_session_id AS rootSessionId,
			name,
			origin,
			fork_turns AS forkTurns,
			depth,
			task,
			branch_entry_id AS branchEntryId,
			created_at AS createdAt,
			updated_at AS updatedAt,
			closed_at AS closedAt,
			close_reason AS closeReason
	`)
	const getSubSessionStmt = db.prepare(`
		SELECT
			child_session_id AS childSessionId,
			parent_session_id AS parentSessionId,
			root_session_id AS rootSessionId,
			name,
			origin,
			fork_turns AS forkTurns,
			depth,
			task,
			branch_entry_id AS branchEntryId,
			created_at AS createdAt,
			updated_at AS updatedAt,
			closed_at AS closedAt,
			close_reason AS closeReason
		FROM sub_sessions
		WHERE child_session_id = ?
	`)
	const listSubSessionsStmt = db.prepare(`
		SELECT
			child_session_id AS childSessionId,
			parent_session_id AS parentSessionId,
			root_session_id AS rootSessionId,
			name,
			origin,
			fork_turns AS forkTurns,
			depth,
			task,
			branch_entry_id AS branchEntryId,
			created_at AS createdAt,
			updated_at AS updatedAt,
			closed_at AS closedAt,
			close_reason AS closeReason
		FROM sub_sessions
		WHERE parent_session_id = ?
		ORDER BY updated_at DESC
	`)
	const listOpenSubSessionsStmt = db.prepare(`
		SELECT
			child_session_id AS childSessionId,
			parent_session_id AS parentSessionId,
			root_session_id AS rootSessionId,
			name,
			origin,
			fork_turns AS forkTurns,
			depth,
			task,
			branch_entry_id AS branchEntryId,
			created_at AS createdAt,
			updated_at AS updatedAt,
			closed_at AS closedAt,
			close_reason AS closeReason
		FROM sub_sessions
		WHERE parent_session_id = ? AND closed_at IS NULL
		ORDER BY updated_at DESC
	`)
	const listRootSubSessionsStmt = db.prepare(`
		SELECT
			child_session_id AS childSessionId,
			parent_session_id AS parentSessionId,
			root_session_id AS rootSessionId,
			name,
			origin,
			fork_turns AS forkTurns,
			depth,
			task,
			branch_entry_id AS branchEntryId,
			created_at AS createdAt,
			updated_at AS updatedAt,
			closed_at AS closedAt,
			close_reason AS closeReason
		FROM sub_sessions
		WHERE root_session_id = ?
		ORDER BY updated_at DESC
	`)
	const listOpenRootSubSessionsStmt = db.prepare(`
		SELECT
			child_session_id AS childSessionId,
			parent_session_id AS parentSessionId,
			root_session_id AS rootSessionId,
			name,
			origin,
			fork_turns AS forkTurns,
			depth,
			task,
			branch_entry_id AS branchEntryId,
			created_at AS createdAt,
			updated_at AS updatedAt,
			closed_at AS closedAt,
			close_reason AS closeReason
		FROM sub_sessions
		WHERE root_session_id = ? AND closed_at IS NULL
		ORDER BY updated_at DESC
	`)
	const sessionSelectSql = (worktreeProjection = "") => `
		SELECT
			s.id,
			s.cwd,
			s.initial_wd AS initialWd,
			s.project_dir AS projectDir,
			s.session_kind AS sessionKind,
			s.created_at AS createdAt,
			s.updated_at AS updatedAt,
			s.deleted_at AS deletedAt,
			s.hidden,
			s.runtime_state AS runtimeState,
			s.agent_view_state AS agentViewState,
			s.agent_view_description AS agentViewDescription,
			s.agent_view_project_tag AS agentViewProjectTag,
			s.agent_view_needs_input AS agentViewNeedsInput,
			s.agent_view_result AS agentViewResult,
			s.agent_view_updated_at AS agentViewUpdatedAt,
			${worktreeProjection}
			latest_run.status AS latestRunStatus,
			latest_run.started_at AS latestRunStartedAt,
			latest_run.ended_at AS latestRunEndedAt,
			latest_run.error AS latestRunError,
			latest_run.stop_reason AS latestRunStopReason
		FROM sessions s
		LEFT JOIN runs latest_run ON latest_run.rowid = (
			SELECT r.rowid
			FROM runs r
			WHERE r.session_id = s.id
			ORDER BY r.started_at DESC, r.rowid DESC
			LIMIT 1
		)
	`
	const listSessionsSelectSql = sessionSelectSql(`
			s.id IN (
				SELECT ser.session_id
				FROM entry_custom_entries ece
				JOIN session_entry_refs ser ON ser.global_id = ece.global_id
				WHERE ece.custom_type = 'git_worktree'
			) AS hasWorktrees,
	`)
	const sessionReadSelectSql = sessionSelectSql()
	const getSessionStmt = db.prepare(`
		${sessionReadSelectSql}
		WHERE s.id = ? AND (? = 1 OR s.deleted_at IS NULL)
	`)
	const getSessionListEntryStmt = db.prepare(`
		${listSessionsSelectSql}
		WHERE s.id = ?
			AND (? = 1 OR s.deleted_at IS NULL)
			AND (? = 1 OR COALESCE(s.hidden, 0) = 0)
	`)
	const listSessionStatusesStmt = db.prepare(`
		${sessionReadSelectSql}
		WHERE (? = 1 OR s.deleted_at IS NULL)
			AND (? = 1 OR COALESCE(s.hidden, 0) = 0)
			AND (
				? IS NULL
				OR COALESCE(NULLIF(s.initial_wd, ''), s.cwd) = ?
				OR instr(COALESCE(NULLIF(s.initial_wd, ''), s.cwd), ?) = 1
			)
		ORDER BY s.deleted_at IS NOT NULL, COALESCE(s.deleted_at, s.updated_at) DESC, s.updated_at DESC
	`)
	const listSessionsStmt = db.prepare(`
		${listSessionsSelectSql}
		WHERE s.deleted_at IS NULL
		ORDER BY s.updated_at DESC
	`)
	const listSessionsForCwdStmt = db.prepare(`
		${listSessionsSelectSql}
		WHERE s.deleted_at IS NULL AND s.cwd = ?
		ORDER BY s.updated_at DESC
	`)
	const listVisibleSessionsStmt = db.prepare(`
		${listSessionsSelectSql}
		WHERE s.deleted_at IS NULL AND COALESCE(s.hidden, 0) = 0
		ORDER BY s.updated_at DESC
	`)
	const listVisibleSessionsForCwdStmt = db.prepare(`
		${listSessionsSelectSql}
		WHERE s.deleted_at IS NULL AND COALESCE(s.hidden, 0) = 0 AND s.cwd = ?
		ORDER BY s.updated_at DESC
	`)
	const listSessionsIncludingDeletedStmt = db.prepare(`
		${listSessionsSelectSql}
		ORDER BY s.deleted_at IS NOT NULL, COALESCE(s.deleted_at, s.updated_at) DESC, s.updated_at DESC
	`)
	const listSessionsIncludingDeletedForCwdStmt = db.prepare(`
		${listSessionsSelectSql}
		WHERE s.cwd = ?
		ORDER BY s.deleted_at IS NOT NULL, COALESCE(s.deleted_at, s.updated_at) DESC, s.updated_at DESC
	`)
	const listVisibleSessionsIncludingDeletedStmt = db.prepare(`
		${listSessionsSelectSql}
		WHERE COALESCE(s.hidden, 0) = 0
		ORDER BY s.deleted_at IS NOT NULL, COALESCE(s.deleted_at, s.updated_at) DESC, s.updated_at DESC
	`)
	const listVisibleSessionsIncludingDeletedForCwdStmt = db.prepare(`
		${listSessionsSelectSql}
		WHERE COALESCE(s.hidden, 0) = 0 AND s.cwd = ?
		ORDER BY s.deleted_at IS NOT NULL, COALESCE(s.deleted_at, s.updated_at) DESC, s.updated_at DESC
	`)
	const listSessionsForDirectoryStmt = db.prepare(`
		${listSessionsSelectSql}
		WHERE (? = 1 OR s.deleted_at IS NULL)
			AND (? = 1 OR COALESCE(s.hidden, 0) = 0)
			AND (
				COALESCE(NULLIF(s.initial_wd, ''), s.cwd) = ?
				OR instr(COALESCE(NULLIF(s.initial_wd, ''), s.cwd), ?) = 1
			)
		ORDER BY s.deleted_at IS NOT NULL, COALESCE(s.deleted_at, s.updated_at) DESC, s.updated_at DESC
	`)
	const previewMessagesStmt = db.prepare(previewMessagesForSelectedSql("(0, ?)"))
	const sessionCustomEntriesStmt = db.prepare(`
		SELECT
			ce.id,
			parent.id AS parentId,
			ce.timestamp,
			ece.data_json AS dataJson
		FROM session_entry_refs ser
		JOIN conversation_entries ce ON ce.global_id = ser.global_id
		JOIN entry_custom_entries ece ON ece.global_id = ser.global_id
		LEFT JOIN conversation_entries parent ON parent.global_id = ce.parent_global_id
		WHERE ser.session_id = ? AND ece.custom_type = ?
		ORDER BY ser.seq ASC
	`)
	const loadSessionPreviewMessagesForSessionBatch = (ids) => {
		if (ids.length === 0) return []
		const values = ids.map((_, i) => `(${i}, ?)`).join(", ")
		const stmt = db.prepare(previewMessagesForSelectedSql(values))
		return stmt.all(...ids).map(previewMessageFromRow)
	}
	const loadSessionPreviewMessagesForSessions = (ids) => ids
		.flatMap((_, i) => i % SESSION_PREVIEW_BATCH_SIZE === 0
			? loadSessionPreviewMessagesForSessionBatch(ids.slice(i, i + SESSION_PREVIEW_BATCH_SIZE))
			: [])
	const cachedOverviewsForSessionBatch = (ids) => {
		if (ids.length === 0) return []
		const values = ids.map(() => "(?)").join(", ")
		const stmt = db.prepare(`
			WITH selected(session_id) AS (
				VALUES ${values}
			)
			SELECT
				so.session_id AS sessionId,
				so.active_leaf_entry_id AS activeLeafEntryId,
				so.first_entry_id AS firstEntryId,
				so.first_timestamp AS firstTimestamp,
				so.first_role AS firstRole,
				so.first_text AS firstText,
				so.last_user_entry_id AS lastUserEntryId,
				so.last_user_timestamp AS lastUserTimestamp,
				so.last_user_text AS lastUserText
			FROM session_overviews so
			JOIN selected ON selected.session_id = so.session_id
		`)
		return stmt.all(...ids)
	}
	const cachedOverviewsForSessions = (ids) => ids
		.flatMap((_, i) => i % SESSION_PREVIEW_BATCH_SIZE === 0
			? cachedOverviewsForSessionBatch(ids.slice(i, i + SESSION_PREVIEW_BATCH_SIZE))
			: [])
	const refreshSessionOverviewsForSessions = (ids) => {
		const uniqueIds = [...new Set(ids.filter(Boolean))]
		if (uniqueIds.length === 0) return []
		db.exec("BEGIN")
		try {
			const refreshed = recomputeSessionOverviewProjections(db, uniqueIds)
			db.exec("COMMIT")
			return refreshed
		} catch (err) {
			db.exec("ROLLBACK")
			throw err
		}
	}
	const latestForCwdStmt = db.prepare(`
		SELECT id FROM sessions
		WHERE deleted_at IS NULL AND COALESCE(hidden, 0) = 0 AND cwd = ?
		ORDER BY updated_at DESC
		LIMIT 1
	`)
	const findByPrefixStmt = db.prepare(`
		SELECT id FROM sessions
		WHERE deleted_at IS NULL AND id LIKE ?
		ORDER BY updated_at DESC
	`)
	const sessionCountStmt = db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE deleted_at IS NULL")
	const getSessionMutationStmt = db.prepare(`
		SELECT
			mutation_version AS mutationVersion,
			mutation_run_id AS mutationRunId,
			runtime_state AS runtimeState,
			agent_view_state AS agentViewState
		FROM sessions
		WHERE id = ? AND deleted_at IS NULL
	`)
	const startRunStmt = db.prepare(`
		INSERT INTO runs (id, session_id, status, started_at)
		VALUES (?, ?, 'running', ?)
	`)
	const startRunSessionStateStmt = db.prepare(`
		UPDATE sessions
		SET runtime_state = 'running',
			runtime_state_updated_at = ?,
			mutation_run_id = ?
		WHERE id = ? AND deleted_at IS NULL
			AND mutation_run_id IS NULL
			AND mutation_version = ?
	`)
	const finishRunStmt = db.prepare(`
		UPDATE runs
		SET status = ?, ended_at = ?, error = ?, stop_reason = ?
		WHERE id = ?
	`)
	const finishRunSessionStateStmt = db.prepare(`
		UPDATE sessions
		SET runtime_state = ?,
			runtime_state_updated_at = ?,
			mutation_run_id = CASE WHEN mutation_run_id = ? THEN NULL ELSE mutation_run_id END
		WHERE id = (SELECT session_id FROM runs WHERE id = ?) AND deleted_at IS NULL
			AND (mutation_run_id IS NULL OR mutation_run_id = ?)
	`)
	const latestInterruptedRunForSessionStmt = db.prepare(`
		SELECT id FROM runs
		WHERE session_id = ? AND status = 'interrupted'
		ORDER BY started_at DESC
		LIMIT 1
	`)
	const finishLatestInterruptedRunSessionStateStmt = db.prepare(`
		UPDATE sessions
		SET runtime_state = ?,
			runtime_state_updated_at = ?,
			mutation_run_id = CASE WHEN mutation_run_id = ? THEN NULL ELSE mutation_run_id END
		WHERE id = ? AND deleted_at IS NULL
			AND (mutation_run_id IS NULL OR mutation_run_id = ?)
	`)
	const interruptRunningStmt = db.prepare(`
		UPDATE runs
		SET status = 'interrupted', ended_at = ?, error = COALESCE(error, 'Pinano server stopped before this run finished.'), stop_reason = 'interrupted'
		WHERE status = 'running'
	`)
	const interruptRunningSessionsStmt = db.prepare(`
		UPDATE sessions
		SET runtime_state = 'interrupted',
			runtime_state_updated_at = ?,
			mutation_run_id = NULL
		WHERE id IN (
			SELECT DISTINCT session_id
			FROM runs
			WHERE status = 'interrupted' AND ended_at = ?
		)
			AND deleted_at IS NULL
	`)
	const startServiceRunStmt = db.prepare(`
		INSERT INTO service_runs (
			id,
			pid,
			cwd,
			transport,
			port,
			code_fingerprint,
			status,
			started_at
		)
		VALUES (?, ?, ?, ?, ?, ?, 'running', ?)
		ON CONFLICT(id) DO UPDATE SET
			pid = excluded.pid,
			cwd = excluded.cwd,
			transport = excluded.transport,
			port = excluded.port,
			code_fingerprint = excluded.code_fingerprint,
			status = 'running',
			started_at = excluded.started_at,
			ended_at = NULL,
			exit_code = NULL,
			signal = NULL,
			reason = NULL
	`)
	const finishServiceRunStmt = db.prepare(`
		UPDATE service_runs
		SET status = ?,
			ended_at = ?,
			exit_code = ?,
			signal = ?,
			reason = ?
		WHERE id = ? AND status = 'running'
	`)
	const recoverServiceRunsStmt = db.prepare(`
		UPDATE service_runs
		SET status = 'unexpected_exit',
			ended_at = ?,
			reason = COALESCE(reason, ?)
		WHERE status = 'running'
			AND (? IS NULL OR id != ?)
	`)
	const listServiceRunsStmt = db.prepare(`
		SELECT
			id,
			pid,
			cwd,
			transport,
			port,
			code_fingerprint AS codeFingerprint,
			status,
			started_at AS startedAt,
			ended_at AS endedAt,
			exit_code AS exitCode,
			signal,
			reason
		FROM service_runs
		ORDER BY started_at DESC
		LIMIT ?
	`)

	/** @type {ServerDb} */
	const api = {
		raw: db,
		upsertSession(session) {
			const at = session.updatedAt ?? nowIso()
			const initialWd = typeof session.initialWd === "string" && session.initialWd ? session.initialWd : session.cwd
			upsertSessionStmt.run(
				session.id,
				session.cwd,
				initialWd,
				session.createdAt ?? at,
				at,
			)
		},
		touchSession(id, cwd, updatedAt) {
			touchSessionStmt.run(updatedAt ?? null, cwd ?? null, id)
		},
		markSessionDeleted(id) {
			markDeletedStmt.run(nowIso(), id)
		},
		restoreSession(id) {
			return Number(restoreSessionStmt.run(id).changes ?? 0) > 0
		},
		setSessionHidden(id, hidden = true) {
			setSessionHiddenStmt.run(hidden ? 1 : 0, id)
		},
		setSessionRuntimeState(id, state) {
			const at = nowIso()
			setRuntimeStateStmt.run(state, at, id)
		},
		setAgentViewMetadata(id, metadata) {
			const at = metadata.updatedAt ?? nowIso()
			setAgentViewStmt.run(
				metadata.state ?? null,
				metadata.descriptionInUi ?? metadata.description ?? null,
				normalizeProjectTag(metadata.projectTag),
				metadata.needsInput ?? null,
				metadata.result ?? null,
				at,
				id,
			)
		},
		setSessionProjectDir(id, projectDir = null) {
			setSessionProjectDirStmt.run(projectDir ?? null, id)
		},
		getAgentViewMetadata(id) {
			const row = getAgentViewStmt.get(id)
			if (!row?.description && !row?.projectTag && !row?.state && !row?.needsInput && !row?.result) return undefined
			return {
				state: row.state ?? undefined,
				descriptionInUi: row.description ?? undefined,
				description: row.description ?? undefined,
				projectTag: row.projectTag ?? undefined,
				needsInput: row.needsInput ?? undefined,
				result: row.result ?? undefined,
				updatedAt: row.updatedAt ?? undefined,
			}
		},
		getSessionMutation(id) {
			const row = getSessionMutationStmt.get(id)
			if (!row) return undefined
			return {
				mutationVersion: Number(row.mutationVersion ?? 0),
				mutationRunId: row.mutationRunId ?? undefined,
				runtimeState: row.runtimeState ?? undefined,
				agentViewState: row.agentViewState ?? undefined,
			}
		},
		getPromptDraft(id) {
			return promptDraftFromRow(getPromptDraftStmt.get(id))
		},
		setPromptDraft(id, text, options = {}) {
			const clientId = typeof options.clientId === "string" && options.clientId ? options.clientId : null
			const clientSeq = Number.isInteger(options.clientSeq) && options.clientSeq > 0 ? options.clientSeq : null
			db.exec("BEGIN IMMEDIATE")
			try {
				if (clientId && clientSeq !== null) {
					const previousClientSeq = Number(getPromptDraftClientSeqStmt.get(id, clientId)?.lastSeq ?? 0)
					if (clientSeq <= previousClientSeq) {
						db.exec("COMMIT")
						return promptDraftFromRow(getPromptDraftStmt.get(id), { applied: false })
					}
				}
				const version = Number(currentPromptDraftVersionStmt.get(id)?.version ?? 0) + 1
				const at = nowIso()
				setPromptDraftStmt.run(id, text, version, at, clientId, clientSeq)
				if (clientId && clientSeq !== null) upsertPromptDraftClientSeqStmt.run(id, clientId, clientSeq)
				db.exec("COMMIT")
				return promptDraftFromRow(getPromptDraftStmt.get(id), { applied: true })
			} catch (err) {
				db.exec("ROLLBACK")
				throw err
			}
		},
		getUiState(key) {
			const row = getUiStateStmt.get(key)
			return row ? parseJson(row.valueJson) : undefined
		},
		setUiState(key, value) {
			const valueJson = JSON.stringify(value)
			if (valueJson === undefined) throw new Error("ui state value must be JSON-serializable")
			setUiStateStmt.run(key, valueJson, nowIso())
			return parseJson(valueJson)
		},
		deleteUiState(key) {
			return Number(deleteUiStateStmt.run(key).changes ?? 0) > 0
		},
		createPromptImageAttachments(sessionId, images, options = {}) {
			const created = []
			if (!Array.isArray(images) || images.length === 0) return created
			const writtenFiles = []
			db.exec("BEGIN IMMEDIATE")
			try {
				let next = nextImageAttachmentNumber(db, sessionId, options.minimumNumber ?? 1)
				for (const image of images) {
					const number = next
					next += 1
					const id = randomUUID()
					const label = promptImageLabel(number)
					const variants = writePromptImageAttachmentFilesSync(sessionId, number, image, { dbPath: path })
					writtenFiles.push(...[variants.display?.filePath, variants.original?.filePath].filter(Boolean))
					insertSessionAttachmentRows(db, {
						id,
						sessionId,
						kind: SESSION_ATTACHMENT_KIND_IMAGE,
						number,
						label,
						detail: image.detail ?? null,
						createdAt: nowIso(),
					}, [variants.display, variants.original])
					created.push({
						type: "image",
						attachmentId: id,
						attachmentSessionId: sessionId,
						imageNumber: number,
						mimeType: variants.display.mimeType,
						...(image.detail ? { detail: image.detail } : {}),
						...(variants.display.widthPx !== null && variants.display.widthPx !== undefined ? { widthPx: variants.display.widthPx } : {}),
						...(variants.display.heightPx !== null && variants.display.heightPx !== undefined ? { heightPx: variants.display.heightPx } : {}),
						storageKey: variants.display.storageKey,
						path: variants.display.filePath,
						...(variants.original ? {
							original: {
								mimeType: variants.original.mimeType,
								...(variants.original.widthPx !== null && variants.original.widthPx !== undefined ? { widthPx: variants.original.widthPx } : {}),
								...(variants.original.heightPx !== null && variants.original.heightPx !== undefined ? { heightPx: variants.original.heightPx } : {}),
								storageKey: variants.original.storageKey,
								path: variants.original.filePath,
							},
						} : {}),
					})
				}
				db.exec("COMMIT")
				return created
			} catch (err) {
				db.exec("ROLLBACK")
				for (const filePath of writtenFiles) rmSync(filePath, { force: true })
				throw err
			}
		},
		getImageAttachment(id) {
			return attachmentImageBlockFromRows(getImageAttachmentByIdStmt.get(id, SESSION_ATTACHMENT_KIND_IMAGE))
		},
		getImageAttachmentByNumber(sessionId, number) {
			return attachmentImageBlockFromRows(getImageAttachmentByNumberStmt.get(
				sessionId,
				SESSION_ATTACHMENT_KIND_IMAGE,
				number,
				sessionId,
				number,
				SESSION_ATTACHMENT_KIND_IMAGE,
			))
		},
		getAttachmentVariant(sessionId, attachmentId, variant = SESSION_ATTACHMENT_VARIANT_DISPLAY) {
			const row = getAttachmentVariantStmt.get(sessionId, attachmentId, variant)
			if (!row?.filePath || !existsSync(row.filePath)) return undefined
			return {
				...row,
				data: readFileSync(row.filePath),
			}
		},
		markProjectMaintenanceSession(record) {
			return projectMaintenanceSessionFromRow(markProjectMaintenanceSessionStmt.get(
				SESSION_KIND_PROJECT_MAINTENANCE,
				record.projectDir,
				record.sessionId,
			))
		},
		getProjectMaintenanceSession(projectDir) {
			return projectMaintenanceSessionFromRow(getProjectMaintenanceSessionStmt.get(SESSION_KIND_PROJECT_MAINTENANCE, projectDir))
		},
		getProjectMaintenanceSessionBySessionId(sessionId) {
			return projectMaintenanceSessionFromRow(getProjectMaintenanceSessionBySessionIdStmt.get(SESSION_KIND_PROJECT_MAINTENANCE, sessionId))
		},
		listProjectMaintenanceSessions() {
			return listProjectMaintenanceSessionsStmt.all(SESSION_KIND_PROJECT_MAINTENANCE).map(projectMaintenanceSessionFromRow)
		},
		upsertPreviewRoot(record) {
			const createdAt = record.createdAt ?? nowIso()
			const updatedAt = record.updatedAt ?? createdAt
			return previewRootCacheFromRow(upsertPreviewRootStmt.get(
				record.scopeId,
				record.scopeKind,
				record.rootPath,
				record.projectDir ?? null,
				record.sessionId ?? null,
				createdAt,
				updatedAt,
			))
		},
		getPreviewRoot(scopeId) {
			return previewRootCacheFromRow(getPreviewRootStmt.get(scopeId))
		},
		listPreviewRoots(scopeKind = undefined) {
			return (scopeKind === undefined
				? listPreviewRootsStmt.all()
				: listPreviewRootsByKindStmt.all(scopeKind)).map(previewRootCacheFromRow)
		},
		upsertSubSession(record) {
			const createdAt = record.createdAt ?? nowIso()
			const updatedAt = record.updatedAt ?? createdAt
			return subSessionFromRow(upsertSubSessionStmt.get(
				record.childSessionId,
				record.parentSessionId,
				record.rootSessionId,
				record.name,
				record.origin,
				record.forkTurns,
				record.depth,
				record.task ?? null,
				record.branchEntryId ?? null,
				createdAt,
				updatedAt,
			))
		},
		closeSubSession(childSessionId, closeReason = undefined, closedAt = undefined) {
			const at = closedAt ?? nowIso()
			return subSessionFromRow(closeSubSessionStmt.get(at, closeReason ?? null, at, childSessionId))
		},
		reopenSubSession(childSessionId, updatedAt = undefined) {
			return subSessionFromRow(reopenSubSessionStmt.get(updatedAt ?? nowIso(), childSessionId))
		},
		getSubSession(childSessionId) {
			return subSessionFromRow(getSubSessionStmt.get(childSessionId))
		},
		listSubSessions(parentSessionId, options = {}) {
			const stmt = options.includeClosed === true ? listSubSessionsStmt : listOpenSubSessionsStmt
			return stmt.all(parentSessionId).map(subSessionFromRow)
		},
		listSubSessionsForRoot(rootSessionId, options = {}) {
			const stmt = options.includeClosed === true ? listRootSubSessionsStmt : listOpenRootSubSessionsStmt
			return stmt.all(rootSessionId).map(subSessionFromRow)
		},
		getSession(id, options = {}) {
			return sessionFromRow(getSessionStmt.get(id, options.includeDeleted === true ? 1 : 0))
		},
		getSessionListEntry(id, options = {}) {
			return sessionFromRow(getSessionListEntryStmt.get(
				id,
				options.includeDeleted === true ? 1 : 0,
				options.includeHidden === true ? 1 : 0,
			))
		},
		listSessions(cwd, options = {}) {
			const includeHidden = options.includeHidden === true
			const includeDeleted = options.includeDeleted === true
			const rows = cwd == null
				? includeDeleted
					? (includeHidden ? listSessionsIncludingDeletedStmt.all() : listVisibleSessionsIncludingDeletedStmt.all())
					: (includeHidden ? listSessionsStmt.all() : listVisibleSessionsStmt.all())
				: includeDeleted
					? (includeHidden ? listSessionsIncludingDeletedForCwdStmt.all(cwd) : listVisibleSessionsIncludingDeletedForCwdStmt.all(cwd))
					: (includeHidden ? listSessionsForCwdStmt.all(cwd) : listVisibleSessionsForCwdStmt.all(cwd))
			return rows.map(sessionFromRow)
		},
		listSessionsForDirectory(cwd, options = {}) {
			const prefix = cwd.endsWith(sep) ? cwd : `${cwd}${sep}`
			return listSessionsForDirectoryStmt.all(
				options.includeDeleted === true ? 1 : 0,
				options.includeHidden === true ? 1 : 0,
				cwd,
				prefix,
			).map(sessionFromRow)
		},
		listSessionStatuses(options = {}) {
			const cwd = typeof options.cwd === "string" && options.cwd ? options.cwd : undefined
			return listSessionStatusesStmt.all(
				options.includeDeleted === true ? 1 : 0,
				options.includeHidden === true ? 1 : 0,
				cwd ?? null,
				cwd ?? null,
				cwd ? (cwd.endsWith(sep) ? cwd : `${cwd}${sep}`) : null,
			).map(sessionFromRow)
		},
		loadSessionCustomEntries(sessionId, customType) {
			return sessionCustomEntriesStmt.all(sessionId, customType).map((row) => ({
				id: row.id,
				parentId: row.parentId ?? null,
				timestamp: row.timestamp,
				type: "custom",
				customType,
				data: parseJson(row.dataJson),
			}))
		},
		loadSessionPreviewMessages(id) {
			return previewMessagesStmt.all(id).map(previewMessageFromRow)
		},
		loadSessionPreviewMessagesForSessions(ids) {
			return loadSessionPreviewMessagesForSessions(ids)
		},
		loadSessionOverviewPreviewMessagesForSessions(ids) {
			const cachedBySessionId = new Map(cachedOverviewsForSessions(ids).map((row) => [row.sessionId, row]))
			return ids.flatMap((id) => {
				const row = cachedBySessionId.get(id)
				return row ? cachedPreviewRowsFromOverview(row) : []
			})
		},
		refreshSessionOverviewsForSessions(ids) {
			return refreshSessionOverviewsForSessions(ids)
		},
		latestSessionForCwd(cwd) {
			return latestForCwdStmt.get(cwd)?.id
		},
		findSessionIdsByPrefix(prefix) {
			return findByPrefixStmt.all(`${prefix}%`).map((row) => row.id)
		},
		replaceSessions(sessions) {
			db.exec("BEGIN IMMEDIATE")
			try {
				db.prepare("UPDATE sessions SET deleted_at = ? WHERE deleted_at IS NULL").run(nowIso())
				for (const session of sessions) api.upsertSession(session)
				db.exec("COMMIT")
			} catch (err) {
				db.exec("ROLLBACK")
				throw err
			}
		},
		sessionCount() {
			return Number(sessionCountStmt.get().n ?? 0)
		},
		startRun(run) {
			const at = run.startedAt ?? nowIso()
			if (!Number.isInteger(run.expectedMutationVersion)) {
				throw mutationError("A session mutation version is required to start a run.", "PINANO_SESSION_MUTATION_VERSION_REQUIRED")
			}
			db.exec("BEGIN IMMEDIATE")
			try {
				startRunStmt.run(run.id, run.sessionId, at)
				const claimed = startRunSessionStateStmt.run(
					at,
					run.id,
					run.sessionId,
					run.expectedMutationVersion,
				)
				if (Number(claimed.changes ?? 0) !== 1) {
					const current = getSessionMutationStmt.get(run.sessionId)
					if (!current) throw mutationError(`Session not found: ${run.sessionId}`, "PINANO_SESSION_NOT_FOUND")
					if (current.mutationRunId) {
						throw mutationError(`Session ${run.sessionId} is already being mutated by run ${current.mutationRunId}.`, "PINANO_SESSION_MUTATION_BUSY")
					}
					throw mutationError(`Session ${run.sessionId} changed in the database; reopen it before starting a run.`, "PINANO_SESSION_STALE")
				}
				db.exec("COMMIT")
			} catch (err) {
				db.exec("ROLLBACK")
				throw err
			}
		},
		finishRun(id, update) {
			const at = update.endedAt ?? nowIso()
			db.exec("BEGIN IMMEDIATE")
			try {
				finishRunStmt.run(
					update.status,
					at,
					update.error ?? null,
					update.stopReason ?? null,
					id,
				)
				const state = update.status === "completed" ? "idle" : normalizeRunStatus(update.status)
				finishRunSessionStateStmt.run(state, at, id, id, id)
				db.exec("COMMIT")
			} catch (err) {
				db.exec("ROLLBACK")
				throw err
			}
		},
		finishLatestInterruptedRunForSession(sessionId, update) {
			const row = latestInterruptedRunForSessionStmt.get(sessionId)
			if (!row?.id) return false
			const at = update.endedAt ?? nowIso()
			db.exec("BEGIN IMMEDIATE")
			try {
				finishRunStmt.run(
					update.status,
					at,
					update.error ?? null,
					update.stopReason ?? null,
					row.id,
				)
				const state = update.status === "completed" ? "idle" : normalizeRunStatus(update.status)
				finishLatestInterruptedRunSessionStateStmt.run(state, at, row.id, sessionId, row.id)
				db.exec("COMMIT")
				return true
			} catch (err) {
				db.exec("ROLLBACK")
				throw err
			}
		},
		interruptRunningRuns() {
			const at = nowIso()
			db.exec("BEGIN IMMEDIATE")
			try {
				const changes = Number(interruptRunningStmt.run(at).changes ?? 0)
				if (changes > 0) interruptRunningSessionsStmt.run(at, at)
				db.exec("COMMIT")
				return changes
			} catch (err) {
				db.exec("ROLLBACK")
				throw err
			}
		},
		startServiceRun(run) {
			startServiceRunStmt.run(
				run.id,
				run.pid ?? null,
				run.cwd,
				run.transport ?? null,
				run.port ?? null,
				run.codeFingerprint ?? null,
				run.startedAt ?? nowIso(),
			)
		},
		finishServiceRun(id, update) {
			finishServiceRunStmt.run(
				update.status,
				update.endedAt ?? nowIso(),
				update.exitCode ?? null,
				update.signal ?? null,
				update.reason ?? null,
				id,
			)
		},
		recoverServiceRuns(reason = "Pinano service started while a previous service was still marked running.", exceptId) {
			return Number(recoverServiceRunsStmt.run(nowIso(), reason, exceptId ?? null, exceptId ?? null).changes ?? 0)
		},
		listServiceRuns(limit = 20) {
			return listServiceRunsStmt.all(Math.max(1, Math.min(100, Number(limit) || 20)))
		},
		close() {
			db.close()
		},
	}

	if (options.recoverRunningRuns) api.interruptRunningRuns()
	return api
}
