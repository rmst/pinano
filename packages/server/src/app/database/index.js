// SQLite database for Cerex server/web mode.
//
// This is the canonical store for sessions, transcript/tree entries, run
// records, service lifecycle rows, and server/client coordination. Keep schema
// changes as explicit migrations using PRAGMA user_version, matching the
// pattern used in our other apps.

import { mkdirSync } from "node:fs"
import { dirname, sep } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { promptImageLabel } from "../../../../protocol/src/prompt-images.js"
import { startOperationSpan, syncOperationTracer } from "../../operation-tracing.js"
import { serverDbPath } from "../paths.js"
import {
	SESSION_ATTACHMENT_KIND_IMAGE,
	SESSION_ATTACHMENT_KIND_PENDING_IMAGE,
	SESSION_ATTACHMENT_VARIANT_DISPLAY,
	SESSION_ATTACHMENT_VARIANT_ORIGINAL,
} from "../session/attachments.js"
import {
	cachedPreviewRowsFromOverview,
	previewMessageFromRow,
	previewMessagesForSelectedSql,
	recomputeSessionOverviewProjections,
} from "../../session-manager/session-overviews.js"

import {
	attachmentImageBlockFromRows,
	attachmentSelectSql,
	insertSessionAttachmentRow,
	insertSessionAttachmentVariantRows,
	nextImageAttachmentNumber,
} from "./attachments.js"
import {
	ensureServerDbSchema,
	SESSION_KIND_NORMAL,
	SESSION_KIND_PROJECT_MAINTENANCE,
} from "./schema.js"
import { nowIso, parseJson } from "./values.js"

export { SCHEMA_VERSION, SESSION_KIND_NORMAL, SESSION_KIND_PROJECT_MAINTENANCE } from "./schema.js"

const SERVER_DB_CACHE_SIZE_KIB = 128 * 1024
const SESSION_PREVIEW_BATCH_SIZE = 200

function sqliteTransaction(db, trace, task, begin = "BEGIN IMMEDIATE") {
	trace("begin", () => db.exec(begin))
	try {
		const result = trace("work", task)
		trace("commit", () => db.exec("COMMIT"))
		return result
	} catch (error) {
		trace("rollback", () => db.exec("ROLLBACK"))
		throw error
	}
}

function instrumentServerDbApi(api, diagnostics) {
	if (diagnostics?.enabled === false || typeof diagnostics?.span !== "function") return api
	for (const [name, method] of Object.entries(api)) {
		if (typeof method !== "function") continue
		api[name] = (...args) => syncOperationTracer(diagnostics, `ServerDb.${name}`, { database: "server" })("call", () => method.apply(api, args))
	}
	return api
}

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
 * @property {string | undefined} [projectRootAtLeaf]
 * @property {string | undefined} [projectId]
 * @property {string | undefined} [projectRetiredAt]
 * @property {string | undefined} [initialWd]
 * @property {boolean} [hidden]
 * @property {boolean} [hasWorktrees]
 * @property {string | undefined} [sessionKind]
 * @property {SubSessionRow} [subSession]
 */

/**
 * @typedef {object} ProjectRow
 * @property {string} id
 * @property {string} root
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string | undefined} [retiredAt]
 */

/**
 * @typedef {object} ProjectSessionRuntimeState
 * @property {string} id
 * @property {string | undefined} [runtimeState]
 * @property {string | undefined} [runtimeStateUpdatedAt]
 */

/**
 * @typedef {object} ProjectRetirement
 * @property {ProjectRow} previousProject
 * @property {ProjectRow} project
 * @property {PreviewRootCacheRow[]} previewRoots
 * @property {ProjectSessionRuntimeState[]} sessionRuntimeStates
 * @property {string[]} legacySessionIds
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
 * @property {(id: string, projection: { cwd?: string, initialWd?: string, projectDir: string | null, updatedAt?: string }) => void} setSessionTranscriptProjection
 * @property {(id: string, projectId: string | null, projectDir: string | null) => void} setSessionProject
 * @property {(record: { id: string, root: string, createdAt?: string, updatedAt?: string }) => ProjectRow} insertProject
 * @property {(id: string) => ProjectRow | undefined} getProject
 * @property {(root: string) => ProjectRow | undefined} getProjectByRoot
 * @property {(projectId: string, legacyRoot: string) => ServerDbSession[]} listSessionsForProject
 * @property {(projectId: string, root: string, previousRoot: string) => ProjectRow} moveProject
 * @property {(projectId: string, root: string) => ProjectRetirement} retireProject
 * @property {(retirement: ProjectRetirement) => ProjectRow} rollbackProjectRetirement
 * @property {(id: string) => { state?: string, descriptionInUi?: string, description?: string, projectTag?: string, needsInput?: string, result?: string, updatedAt?: string } | undefined} getAgentViewMetadata
 * @property {(id: string) => { mutationVersion: number, mutationRunId?: string, runtimeState?: string, agentViewState?: string } | undefined} getSessionMutation
 * @property {(id: string) => PromptDraft} getPromptDraft
 * @property {(id: string, text: string, options?: { clientId?: string, clientSeq?: number }) => PromptDraft} setPromptDraft
 * @property {(key: string) => any | undefined} getUiState
 * @property {(key: string, value: any) => any} setUiState
 * @property {(key: string) => boolean} deleteUiState
 * @property {(sessionId: string, reservations: Array<{ id: string, detail?: string | null }>, options: { minimumNumber: number }) => Array<{ id: string, sessionId: string, number: number, label: string, detail: string | null, createdAt: string }>} reservePromptImageAttachments
 * @property {(sessionId: string, attachments: Array<{ id: string, number: number, variants: { display: any, original?: any } }>) => any[]} finalizePromptImageAttachments
 * @property {(sessionId: string, ids: string[]) => number} cancelPromptImageAttachmentReservations
 * @property {() => Array<{ id: string, sessionId: string, number: number, label: string, detail: string | null, createdAt: string }>} listPendingPromptImageAttachmentReservations
 * @property {(id: string) => any | undefined} getImageAttachment
 * @property {(sessionId: string, number: number) => any | undefined} getImageAttachmentByNumber
 * @property {(sessionId: string, attachmentId: string, variant?: string) => ({ mimeType: string, filename?: string, filePath?: string } & Record<string, any>) | undefined} getAttachmentVariantMetadata
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
		projectRootAtLeaf: row.projectRootAtLeaf ?? row.projectDir ?? undefined,
		projectId: row.projectId ?? undefined,
		projectRetiredAt: row.projectRetiredAt ?? undefined,
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

function projectFromRow(row) {
	if (!row) return undefined
	return {
		id: row.id,
		root: row.root,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		retiredAt: row.retiredAt ?? undefined,
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
 * Open the Cerex server metadata db, initializing a fresh schema when needed.
 * @param {{ path?: string, recoverRunningRuns?: boolean, diagnostics?: any }} [options]
 * @returns {ServerDb}
 */
export function openServerDb(options = {}) {
	const path = options.path ?? serverDbPath()
	const diagnostics = options.diagnostics
	const openTrace = syncOperationTracer(diagnostics, "ServerDb.open", { database: "server" })
	openTrace("mkdir", () => mkdirSync(dirname(path), { recursive: true }))
	const db = openTrace("connect", () => new DatabaseSync(path))
	openTrace("configure", () => {
		db.exec(`PRAGMA cache_size = -${SERVER_DB_CACHE_SIZE_KIB}`)
		db.exec("PRAGMA journal_mode = WAL")
		db.exec("PRAGMA busy_timeout = 1000")
	})
	openTrace("schema", () => ensureServerDbSchema(db))
	openTrace("foreignKeys", () => db.exec("PRAGMA foreign_keys = ON"))
	const endPrepare = startOperationSpan(diagnostics, "ServerDb.open.prepare", { database: "server" })

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
	const setSessionTranscriptProjectionStmt = db.prepare(`
		UPDATE sessions
		SET cwd = COALESCE(?, cwd),
			initial_wd = COALESCE(?, initial_wd),
			project_dir = ?,
			updated_at = COALESCE(?, updated_at)
		WHERE id = ? AND deleted_at IS NULL
	`)
	const setSessionProjectStmt = db.prepare("UPDATE sessions SET project_id = ?, project_dir = ? WHERE id = ?")
	const insertProjectStmt = db.prepare(`
		INSERT INTO projects (id, root, created_at, updated_at)
		VALUES (?, ?, ?, ?)
		RETURNING id, root, created_at AS createdAt, updated_at AS updatedAt, retired_at AS retiredAt
	`)
	const getProjectStmt = db.prepare(`
		SELECT id, root, created_at AS createdAt, updated_at AS updatedAt, retired_at AS retiredAt
		FROM projects
		WHERE id = ?
	`)
	const getProjectByRootStmt = db.prepare(`
		SELECT id, root, created_at AS createdAt, updated_at AS updatedAt, retired_at AS retiredAt
		FROM projects
		WHERE root = ? AND retired_at IS NULL
	`)
	const updateProjectRootStmt = db.prepare(`
		UPDATE projects
		SET root = ?, updated_at = ?
		WHERE id = ? AND retired_at IS NULL
		RETURNING id, root, created_at AS createdAt, updated_at AS updatedAt, retired_at AS retiredAt
	`)
	const retireProjectStmt = db.prepare(`
		UPDATE projects
		SET retired_at = ?, updated_at = ?
		WHERE id = ? AND root = ? AND retired_at IS NULL
		RETURNING id, root, created_at AS createdAt, updated_at AS updatedAt, retired_at AS retiredAt
	`)
	const rollbackProjectRetirementStmt = db.prepare(`
		UPDATE projects
		SET root = ?, updated_at = ?, retired_at = NULL
		WHERE id = ? AND root = ? AND retired_at = ?
		RETURNING id, root, created_at AS createdAt, updated_at AS updatedAt, retired_at AS retiredAt
	`)
	const retireProjectMaintenanceSessionsStmt = db.prepare(`
		UPDATE sessions
		SET deleted_at = ?
		WHERE project_id = ? AND session_kind = ? AND deleted_at IS NULL
	`)
	const idleProjectSessionsStmt = db.prepare(`
		UPDATE sessions
		SET runtime_state = 'idle', runtime_state_updated_at = ?
		WHERE project_id = ?
	`)
	const selectProjectSessionRuntimeStatesStmt = db.prepare(`
		SELECT id, runtime_state AS runtimeState, runtime_state_updated_at AS runtimeStateUpdatedAt
		FROM sessions
		WHERE project_id = ?
	`)
	const rollbackProjectSessionRuntimeStateStmt = db.prepare(`
		UPDATE sessions
		SET runtime_state = ?, runtime_state_updated_at = ?
		WHERE id = ? AND project_id = ? AND runtime_state_updated_at = ?
	`)
	const restoreRetiredProjectMaintenanceSessionsStmt = db.prepare(`
		UPDATE sessions
		SET deleted_at = NULL
		WHERE project_id = ? AND session_kind = ? AND deleted_at = ?
	`)
	const associateLegacyProjectSessionsStmt = db.prepare(`
		UPDATE sessions
		SET project_id = ?
		WHERE project_id IS NULL AND project_dir = ?
	`)
	const selectLegacyProjectSessionIdsStmt = db.prepare(`
		SELECT id
		FROM sessions
		WHERE project_id IS NULL AND project_dir = ?
	`)
	const rollbackLegacyProjectSessionAssociationStmt = db.prepare(`
		UPDATE sessions
		SET project_id = NULL
		WHERE id = ? AND project_id = ? AND project_dir = ?
	`)
	const deletePreviewRootsForProjectStmt = db.prepare("DELETE FROM preview_root_cache WHERE project_dir = ?")
	const selectPreviewRootsForProjectStmt = db.prepare(`
		SELECT
			scope_id AS scopeId,
			scope_kind AS scopeKind,
			root_path AS rootPath,
			project_dir AS projectDir,
			session_id AS sessionId,
			created_at AS createdAt,
			updated_at AS updatedAt
		FROM preview_root_cache
		WHERE project_dir = ?
	`)
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
	const getPromptImageAttachmentReservationStmt = db.prepare(`
		SELECT
			id,
			session_id AS sessionId,
			number,
			label,
			detail,
			created_at AS createdAt
		FROM session_attachments
		WHERE id = ? AND session_id = ? AND kind = ?
	`)
	const finalizePromptImageAttachmentReservationStmt = db.prepare(`
		UPDATE session_attachments
		SET kind = ?
		WHERE id = ? AND session_id = ? AND number = ? AND kind = ?
	`)
	const cancelPromptImageAttachmentReservationStmt = db.prepare(`
		DELETE FROM session_attachments
		WHERE id = ? AND session_id = ? AND kind = ?
	`)
	const listPendingPromptImageAttachmentReservationsStmt = db.prepare(`
		SELECT
			id,
			session_id AS sessionId,
			number,
			label,
			detail,
			created_at AS createdAt
		FROM session_attachments
		WHERE kind = ?
		ORDER BY created_at ASC, id ASC
	`)
	const getImageAttachmentByNumberStmt = db.prepare(attachmentSelectSql(`
		JOIN (
			SELECT owned.id AS attachmentId, 0 AS rank
			FROM session_attachments owned
			WHERE owned.session_id = ? AND owned.kind = ? AND owned.number = ?
			UNION ALL
			SELECT mb.image_attachment_id AS attachmentId, 1 AS rank
			FROM session_entries ser
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
	const getAttachmentVariantMetadataStmt = db.prepare(`
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
			AND a.kind = ?
	`)
	const markProjectMaintenanceSessionStmt = db.prepare(`
		UPDATE sessions
		SET session_kind = ?,
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
			COALESCE(p.root, s.project_dir) AS projectDir,
			s.id AS sessionId,
			s.created_at AS createdAt,
			s.updated_at AS updatedAt
		FROM sessions s
		LEFT JOIN projects p ON p.id = s.project_id
		WHERE s.deleted_at IS NULL
			AND s.session_kind = ?
			AND COALESCE(p.root, s.project_dir) = ?
	`)
	const getProjectMaintenanceSessionBySessionIdStmt = db.prepare(`
		SELECT
			COALESCE(p.root, s.project_dir) AS projectDir,
			s.id AS sessionId,
			s.created_at AS createdAt,
			s.updated_at AS updatedAt
		FROM sessions s
		LEFT JOIN projects p ON p.id = s.project_id
		WHERE s.deleted_at IS NULL
			AND s.session_kind = ?
			AND s.id = ?
	`)
	const listProjectMaintenanceSessionsStmt = db.prepare(`
		SELECT
			COALESCE(p.root, s.project_dir) AS projectDir,
			s.id AS sessionId,
			s.created_at AS createdAt,
			s.updated_at AS updatedAt
		FROM sessions s
		LEFT JOIN projects p ON p.id = s.project_id
		WHERE s.deleted_at IS NULL
			AND s.session_kind = ?
		ORDER BY s.updated_at DESC
	`)
	const upsertPreviewRootStmt = db.prepare(`
		INSERT INTO preview_root_cache (scope_id, scope_kind, root_path, project_dir, session_id, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT DO UPDATE SET
			scope_id = excluded.scope_id,
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
			s.project_dir AS projectRootAtLeaf,
			COALESCE(p.root, s.project_dir) AS projectDir,
			s.project_id AS projectId,
			p.retired_at AS projectRetiredAt,
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
		LEFT JOIN projects p ON p.id = s.project_id
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
				JOIN session_entries ser ON ser.global_id = ece.global_id
				WHERE ece.custom_type = 'git_worktree'
			) AS hasWorktrees,
	`)
	const sessionReadSelectSql = sessionSelectSql()
	const listSessionsForProjectStmt = db.prepare(`
		${sessionReadSelectSql}
		WHERE s.project_id = ? OR (s.project_id IS NULL AND s.project_dir = ?)
		ORDER BY s.deleted_at IS NOT NULL, COALESCE(s.deleted_at, s.updated_at) DESC, s.updated_at DESC
	`)
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
				OR p.root = ?
				OR instr(p.root, ?) = 1
				OR instr(?, p.root || ?) = 1
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
				OR p.root = ?
				OR instr(p.root, ?) = 1
				OR instr(?, p.root || ?) = 1
			)
		ORDER BY s.deleted_at IS NOT NULL, COALESCE(s.deleted_at, s.updated_at) DESC, s.updated_at DESC
	`)
	const previewMessagesStmt = db.prepare(previewMessagesForSelectedSql("(0, ?)"))
	const sessionCustomEntriesStmt = db.prepare(`
		SELECT
			ser.entry_id AS id,
			ser.parent_entry_id AS parentId,
			ser.timestamp,
			ece.data_json AS dataJson
		FROM session_entries ser
		JOIN entry_custom_entries ece ON ece.global_id = ser.global_id
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
		const trace = syncOperationTracer(diagnostics, "ServerDb.refreshSessionOverviews.transaction", {
			database: "server",
			sessionCount: uniqueIds.length,
		})
		return sqliteTransaction(db, trace, () => recomputeSessionOverviewProjections(db, uniqueIds), "BEGIN")
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
		SET status = 'interrupted', ended_at = ?, error = COALESCE(error, 'Cerex server stopped before this run finished.'), stop_reason = 'interrupted'
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
	endPrepare()

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
		setSessionTranscriptProjection(id, projection) {
			setSessionTranscriptProjectionStmt.run(
				projection.cwd ?? null,
				projection.initialWd ?? null,
				projection.projectDir ?? null,
				projection.updatedAt ?? null,
				id,
			)
		},
		setSessionProject(id, projectId, projectDir) {
			setSessionProjectStmt.run(projectId ?? null, projectDir ?? null, id)
		},
		insertProject(record) {
			const createdAt = record.createdAt ?? nowIso()
			return projectFromRow(insertProjectStmt.get(record.id, record.root, createdAt, record.updatedAt ?? createdAt))
		},
		getProject(id) {
			return projectFromRow(getProjectStmt.get(id))
		},
		getProjectByRoot(root) {
			return projectFromRow(getProjectByRootStmt.get(root))
		},
		listSessionsForProject(projectId, legacyRoot) {
			return listSessionsForProjectStmt.all(projectId, legacyRoot).map(sessionFromRow)
		},
		moveProject(projectId, root, previousRoot) {
			const trace = syncOperationTracer(diagnostics, "ServerDb.moveProject.transaction", { database: "server", projectId })
			return sqliteTransaction(db, trace, () => {
				associateLegacyProjectSessionsStmt.run(projectId, previousRoot)
				deletePreviewRootsForProjectStmt.run(previousRoot)
				const project = projectFromRow(updateProjectRootStmt.get(root, nowIso(), projectId))
				if (!project) throw new Error(`Project not found: ${projectId}`)
				return project
			})
		},
		retireProject(projectId, root) {
			const trace = syncOperationTracer(diagnostics, "ServerDb.retireProject.transaction", { database: "server", projectId })
			return sqliteTransaction(db, trace, () => {
				const legacySessionIds = selectLegacyProjectSessionIdsStmt.all(root).map((row) => row.id)
				associateLegacyProjectSessionsStmt.run(projectId, root)
				const previousProject = projectFromRow(getProjectStmt.get(projectId))
				if (!previousProject || previousProject.root !== root || previousProject.retiredAt) {
					throw new Error(`Active project not found at ${root}: ${projectId}`)
				}
				const previewRoots = selectPreviewRootsForProjectStmt.all(root).map(previewRootCacheFromRow)
				const sessionRuntimeStates = selectProjectSessionRuntimeStatesStmt.all(projectId).map((row) => ({
					id: row.id,
					runtimeState: row.runtimeState ?? undefined,
					runtimeStateUpdatedAt: row.runtimeStateUpdatedAt ?? undefined,
				}))
				const retiredAt = nowIso()
				const project = projectFromRow(retireProjectStmt.get(retiredAt, retiredAt, projectId, root))
				if (!project) throw new Error(`Active project not found at ${root}: ${projectId}`)
				idleProjectSessionsStmt.run(retiredAt, projectId)
				retireProjectMaintenanceSessionsStmt.run(retiredAt, projectId, SESSION_KIND_PROJECT_MAINTENANCE)
				deletePreviewRootsForProjectStmt.run(root)
				return { previousProject, project, previewRoots, sessionRuntimeStates, legacySessionIds }
			})
		},
		rollbackProjectRetirement(retirement) {
			const projectId = retirement.project.id
			const retiredAt = retirement.project.retiredAt
			if (!retiredAt) throw new Error(`Project retirement is missing a retirement timestamp: ${projectId}`)
			const trace = syncOperationTracer(diagnostics, "ServerDb.rollbackProjectRetirement.transaction", { database: "server", projectId })
			return sqliteTransaction(db, trace, () => {
				const project = projectFromRow(rollbackProjectRetirementStmt.get(
					retirement.previousProject.root,
					retirement.previousProject.updatedAt,
					projectId,
					retirement.project.root,
					retiredAt,
				))
				if (!project) throw new Error(`Project retirement can no longer be rolled back: ${projectId}`)
				restoreRetiredProjectMaintenanceSessionsStmt.run(projectId, SESSION_KIND_PROJECT_MAINTENANCE, retiredAt)
				for (const session of retirement.sessionRuntimeStates) {
					rollbackProjectSessionRuntimeStateStmt.run(
						session.runtimeState ?? null,
						session.runtimeStateUpdatedAt ?? null,
						session.id,
						projectId,
						retiredAt,
					)
				}
				for (const sessionId of retirement.legacySessionIds) {
					rollbackLegacyProjectSessionAssociationStmt.run(sessionId, projectId, retirement.previousProject.root)
				}
				for (const preview of retirement.previewRoots) {
					upsertPreviewRootStmt.get(
						preview.scopeId,
						preview.scopeKind,
						preview.rootPath,
						preview.projectDir ?? null,
						preview.sessionId ?? null,
						preview.createdAt,
						preview.updatedAt,
					)
				}
				return project
			})
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
			const trace = syncOperationTracer(diagnostics, "ServerDb.setPromptDraft.transaction", {
				database: "server",
				sessionId: id,
				textChars: text.length,
			})
			return sqliteTransaction(db, trace, () => {
				if (clientId && clientSeq !== null) {
					const previousClientSeq = Number(getPromptDraftClientSeqStmt.get(id, clientId)?.lastSeq ?? 0)
					if (clientSeq <= previousClientSeq) {
						return promptDraftFromRow(getPromptDraftStmt.get(id), { applied: false })
					}
				}
				const version = Number(currentPromptDraftVersionStmt.get(id)?.version ?? 0) + 1
				const at = nowIso()
				setPromptDraftStmt.run(id, text, version, at, clientId, clientSeq)
				if (clientId && clientSeq !== null) upsertPromptDraftClientSeqStmt.run(id, clientId, clientSeq)
				return promptDraftFromRow(getPromptDraftStmt.get(id), { applied: true })
			})
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
		reservePromptImageAttachments(sessionId, reservations, options = {}) {
			if (!Array.isArray(reservations) || reservations.length === 0) return []
			if (!Number.isInteger(options.minimumNumber) || options.minimumNumber <= 0) {
				throw new TypeError("prompt image minimum number must be a positive integer")
			}
			const ids = new Set()
			for (const reservation of reservations) {
				if (typeof reservation?.id !== "string" || !reservation.id || ids.has(reservation.id)) {
					throw new TypeError("prompt image reservation ids must be unique non-empty strings")
				}
				ids.add(reservation.id)
			}
			const trace = syncOperationTracer(diagnostics, "ServerDb.reservePromptImageAttachments.transaction", {
				database: "server",
				sessionId,
				imageCount: reservations.length,
			})
			return sqliteTransaction(db, trace, () => {
				let next = trace("number", () => nextImageAttachmentNumber(db, sessionId, options.minimumNumber))
				return trace("insert", () => reservations.map((reservation) => {
					const number = next
					next += 1
					const row = {
						id: reservation.id,
						sessionId,
						kind: SESSION_ATTACHMENT_KIND_PENDING_IMAGE,
						number,
						label: promptImageLabel(number),
						detail: reservation.detail ?? null,
						createdAt: nowIso(),
					}
					insertSessionAttachmentRow(db, row)
					return {
						id: row.id,
						sessionId: row.sessionId,
						number: row.number,
						label: row.label,
						detail: row.detail,
						createdAt: row.createdAt,
					}
				}))
			})
		},
		finalizePromptImageAttachments(sessionId, attachments) {
			if (!Array.isArray(attachments) || attachments.length === 0) return []
			const ids = new Set()
			for (const attachment of attachments) {
				if (typeof attachment?.id !== "string" || !attachment.id || ids.has(attachment.id)) {
					throw new TypeError("prompt image attachment ids must be unique non-empty strings")
				}
				if (!Number.isInteger(attachment.number) || attachment.number <= 0) {
					throw new TypeError("prompt image attachment numbers must be positive integers")
				}
				if (attachment.variants?.display?.variant !== SESSION_ATTACHMENT_VARIANT_DISPLAY
					|| (attachment.variants?.original && attachment.variants.original.variant !== SESSION_ATTACHMENT_VARIANT_ORIGINAL)) {
					throw new TypeError("prompt image attachments require a display variant and an optional original variant")
				}
				ids.add(attachment.id)
			}
			const trace = syncOperationTracer(diagnostics, "ServerDb.finalizePromptImageAttachments.transaction", {
				database: "server",
				sessionId,
				imageCount: attachments.length,
			})
			return sqliteTransaction(db, trace, () => {
				for (const attachment of attachments) {
					const reservation = getPromptImageAttachmentReservationStmt.get(
						attachment.id,
						sessionId,
						SESSION_ATTACHMENT_KIND_PENDING_IMAGE,
					)
					if (!reservation || Number(reservation.number) !== attachment.number) {
						throw Object.assign(new Error(`Prompt image reservation is no longer pending: ${attachment.id}`), {
							code: "promptImageReservationInvalid",
							status: 409,
						})
					}
					insertSessionAttachmentVariantRows(db, attachment.id, [attachment.variants.display, attachment.variants.original])
					const changes = Number(finalizePromptImageAttachmentReservationStmt.run(
						SESSION_ATTACHMENT_KIND_IMAGE,
						attachment.id,
						sessionId,
						attachment.number,
						SESSION_ATTACHMENT_KIND_PENDING_IMAGE,
					).changes ?? 0)
					if (changes !== 1) throw new Error(`Could not finalize prompt image reservation: ${attachment.id}`)
				}
				return attachments.map((attachment) => attachmentImageBlockFromRows(
					getImageAttachmentByIdStmt.get(attachment.id, SESSION_ATTACHMENT_KIND_IMAGE),
				))
			})
		},
		cancelPromptImageAttachmentReservations(sessionId, ids) {
			if (!Array.isArray(ids) || ids.length === 0) return 0
			const trace = syncOperationTracer(diagnostics, "ServerDb.cancelPromptImageAttachmentReservations.transaction", {
				database: "server",
				sessionId,
				imageCount: ids.length,
			})
			return sqliteTransaction(db, trace, () => ids.reduce((count, id) => count + Number(
				cancelPromptImageAttachmentReservationStmt.run(id, sessionId, SESSION_ATTACHMENT_KIND_PENDING_IMAGE).changes ?? 0
			), 0))
		},
		listPendingPromptImageAttachmentReservations() {
			return listPendingPromptImageAttachmentReservationsStmt.all(SESSION_ATTACHMENT_KIND_PENDING_IMAGE)
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
		getAttachmentVariantMetadata(sessionId, attachmentId, variant = SESSION_ATTACHMENT_VARIANT_DISPLAY) {
			return getAttachmentVariantMetadataStmt.get(sessionId, attachmentId, variant, SESSION_ATTACHMENT_KIND_IMAGE)
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
				cwd,
				prefix,
				cwd,
				sep,
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
				cwd ?? null,
				cwd ? (cwd.endsWith(sep) ? cwd : `${cwd}${sep}`) : null,
				cwd ?? null,
				sep,
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
			const trace = syncOperationTracer(diagnostics, "ServerDb.replaceSessions.transaction", {
				database: "server",
				sessionCount: sessions.length,
			})
			sqliteTransaction(db, trace, () => {
				db.prepare("UPDATE sessions SET deleted_at = ? WHERE deleted_at IS NULL").run(nowIso())
				for (const session of sessions) api.upsertSession(session)
			})
		},
		sessionCount() {
			return Number(sessionCountStmt.get().n ?? 0)
		},
		startRun(run) {
			const at = run.startedAt ?? nowIso()
			if (!Number.isInteger(run.expectedMutationVersion)) {
				throw mutationError("A session mutation version is required to start a run.", "CEREX_SESSION_MUTATION_VERSION_REQUIRED")
			}
			const trace = syncOperationTracer(diagnostics, "ServerDb.startRun.transaction", {
				database: "server",
				sessionId: run.sessionId,
			})
			sqliteTransaction(db, trace, () => {
				startRunStmt.run(run.id, run.sessionId, at)
				const claimed = startRunSessionStateStmt.run(
					at,
					run.id,
					run.sessionId,
					run.expectedMutationVersion,
				)
				if (Number(claimed.changes ?? 0) !== 1) {
					const current = getSessionMutationStmt.get(run.sessionId)
					if (!current) throw mutationError(`Session not found: ${run.sessionId}`, "CEREX_SESSION_NOT_FOUND")
					if (current.mutationRunId) {
						throw mutationError(`Session ${run.sessionId} is already being mutated by run ${current.mutationRunId}.`, "CEREX_SESSION_MUTATION_BUSY")
					}
					throw mutationError(`Session ${run.sessionId} changed in the database; reopen it before starting a run.`, "CEREX_SESSION_STALE")
				}
			})
		},
		finishRun(id, update) {
			const at = update.endedAt ?? nowIso()
			const trace = syncOperationTracer(diagnostics, "ServerDb.finishRun.transaction", {
				database: "server",
				status: update.status,
			})
			sqliteTransaction(db, trace, () => {
				finishRunStmt.run(
					update.status,
					at,
					update.error ?? null,
					update.stopReason ?? null,
					id,
				)
				const state = update.status === "completed" ? "idle" : normalizeRunStatus(update.status)
				finishRunSessionStateStmt.run(state, at, id, id, id)
			})
		},
		finishLatestInterruptedRunForSession(sessionId, update) {
			const row = latestInterruptedRunForSessionStmt.get(sessionId)
			if (!row?.id) return false
			const at = update.endedAt ?? nowIso()
			const trace = syncOperationTracer(diagnostics, "ServerDb.finishLatestInterruptedRun.transaction", {
				database: "server",
				sessionId,
				status: update.status,
			})
			return sqliteTransaction(db, trace, () => {
				finishRunStmt.run(
					update.status,
					at,
					update.error ?? null,
					update.stopReason ?? null,
					row.id,
				)
				const state = update.status === "completed" ? "idle" : normalizeRunStatus(update.status)
				finishLatestInterruptedRunSessionStateStmt.run(state, at, row.id, sessionId, row.id)
				return true
			})
		},
		interruptRunningRuns() {
			const at = nowIso()
			const trace = syncOperationTracer(diagnostics, "ServerDb.interruptRunningRuns.transaction", { database: "server" })
			return sqliteTransaction(db, trace, () => {
				const changes = Number(interruptRunningStmt.run(at).changes ?? 0)
				if (changes > 0) interruptRunningSessionsStmt.run(at, at)
				return changes
			})
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
		recoverServiceRuns(reason = "Cerex service started while a previous service was still marked running.", exceptId) {
			return Number(recoverServiceRunsStmt.run(nowIso(), reason, exceptId ?? null, exceptId ?? null).changes ?? 0)
		},
		listServiceRuns(limit = 20) {
			return listServiceRunsStmt.all(Math.max(1, Math.min(100, Number(limit) || 20)))
		},
		close() {
			db.close()
		},
	}

	const instrumentedApi = instrumentServerDbApi(api, diagnostics)
	if (options.recoverRunningRuns) instrumentedApi.interruptRunningRuns()
	return instrumentedApi
}
