import { isAbsolute } from "node:path"

import { sessionInitialWd } from "./config.js"

export const SESSION_CUSTOM_TYPE_PROPERTIES = "session_properties"

export const SESSION_DISCUSSING_STATE = "discussing"
export const SESSION_READY_FOR_REVIEW_STATE = "readyForReview"
export const SESSION_NEEDS_INPUT_STATE = "needs_input"
export const SESSION_COMPLETED_STATE = "completed"
export const SESSION_DEFERRED_STATE = "deferred"
export const SESSION_WORKTREE_LIFECYCLE_MAINTENANCE = "worktree_lifecycle"
export const SESSION_PROPERTY_STATES = [SESSION_DISCUSSING_STATE, SESSION_READY_FOR_REVIEW_STATE, SESSION_NEEDS_INPUT_STATE, SESSION_COMPLETED_STATE, SESSION_DEFERRED_STATE]
export const SESSION_WORKTREE_MAINTENANCE_STATES = [SESSION_NEEDS_INPUT_STATE, SESSION_READY_FOR_REVIEW_STATE]
const SESSION_PROPERTY_KEYS = ["state", "descriptionInUi", "projectTag", "projectDir", "cwd", "environmentId"]
const SESSION_PROPERTY_KEY_SET = new Set(SESSION_PROPERTY_KEYS)

/** @param {unknown} value @param {string} field @param {number} max */
function cleanNullableText(value, field, max) {
	if (value === null) return null
	if (value === undefined) return undefined
	if (typeof value !== "string") throw new TypeError(`${field} must be a string, null, or omitted`)
	const text = value.replace(/\s+/g, " ").trim()
	return text ? text.slice(0, max) : null
}

/** @param {unknown} value */
function cleanProjectTag(value) {
	const text = cleanNullableText(value, "projectTag", 64)
	if (text === null || text === undefined) return text
	return text.toLowerCase().replace(/[^a-z0-9._/-]+/g, " ").trim().replace(/\s+/g, " ") || null
}

/** @param {unknown} value */
function cleanRequiredString(value, field) {
	if (typeof value !== "string") throw new TypeError(`${field} must be a string`)
	const text = value.trim()
	if (!text) throw new TypeError(`${field} must not be empty`)
	return text
}

/** @param {unknown} value @param {string} field */
function cleanNullableAbsolutePath(value, field) {
	if (value === null) return null
	if (value === undefined) return undefined
	const text = cleanRequiredString(value, field)
	if (!isAbsolute(text)) throw new TypeError(`${field} must be an absolute path`)
	return text
}

/**
 * @param {any} patch
 * @param {{ allowEmpty?: boolean, allowedStates?: string[], allowNullState?: boolean, allowState?: boolean, nullState?: string }} [options]
 */
export function normalizeSessionPropertyPatch(patch, options = {}) {
	if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new TypeError("session property patch expects an object")
	const unknown = Object.keys(patch).filter((key) => !SESSION_PROPERTY_KEY_SET.has(key))
	if (unknown.length > 0) throw new TypeError(`Unknown session property field(s): ${unknown.join(", ")}`)
	if (!options.allowEmpty && Object.keys(patch).length === 0) throw new TypeError("session property patch expects at least one property")
	const allowedStates = options.allowedStates ?? SESSION_PROPERTY_STATES
	const allowedStateSet = new Set(allowedStates)
	const allowNullState = options.allowNullState !== false
	const allowedStateDescription = allowedStates.join(", ")
	const out = {}
	if (Object.prototype.hasOwnProperty.call(patch, "state")) {
		if (options.allowState === false) throw new TypeError("state is not settable through this session property surface")
		if ((patch.state === null || patch.state === "null") && allowNullState) out.state = options.nullState ?? SESSION_DISCUSSING_STATE
		else if (typeof patch.state === "string" && allowedStateSet.has(patch.state)) out.state = patch.state
		else throw new TypeError(`state must be one of ${allowedStateDescription}`)
	}
	if (Object.prototype.hasOwnProperty.call(patch, "descriptionInUi")) out.descriptionInUi = cleanNullableText(patch.descriptionInUi, "descriptionInUi", 160)
	if (Object.prototype.hasOwnProperty.call(patch, "projectTag")) out.projectTag = cleanProjectTag(patch.projectTag)
	if (Object.prototype.hasOwnProperty.call(patch, "projectDir")) out.projectDir = cleanNullableAbsolutePath(patch.projectDir, "projectDir")
	if (Object.prototype.hasOwnProperty.call(patch, "cwd")) {
		const cwd = cleanRequiredString(patch.cwd, "cwd")
		if (!isAbsolute(cwd)) throw new TypeError("cwd must be an absolute path")
		out.cwd = cwd
	}
	if (Object.prototype.hasOwnProperty.call(patch, "environmentId")) out.environmentId = cleanRequiredString(patch.environmentId, "environmentId")
	return out
}

/** @param {any} state */
export function normalizeStoredSessionState(state, options = {}) {
	return state === undefined || state === null || state === "null"
		? options.nullState ?? SESSION_DISCUSSING_STATE
		: state === "ready_for_review"
			? SESSION_READY_FOR_REVIEW_STATE
			: state
}

export function defaultSessionProperties(session) {
	return {
		state: normalizeStoredSessionState(session?.legacySessionProperties?.state),
		descriptionInUi: session?.legacySessionProperties?.descriptionInUi ?? session?.legacySessionProperties?.description,
		projectTag: session?.legacySessionProperties?.projectTag,
		projectDir: session?.legacySessionProperties?.projectDir,
		cwd: session?.legacySessionProperties?.cwd ?? session?.getMetadata?.().cwd ?? process.cwd(),
		environmentId: session?.legacySessionProperties?.environmentId ?? "local",
		updatedAt: session?.legacySessionProperties?.updatedAt,
	}
}

/** @param {any} base @param {any} patch @param {string | undefined} updatedAt */
export function applySessionPropertyPatch(base, patch, updatedAt = undefined) {
	const next = { ...base }
	for (const [key, value] of Object.entries(patch ?? {})) next[key] = key === "state" ? normalizeStoredSessionState(value, { nullState: SESSION_READY_FOR_REVIEW_STATE }) : value === null ? null : value
	if (updatedAt) next.updatedAt = updatedAt
	return next
}

/** @param {any} session */
export function hasSessionPropertyEntries(session) {
	return (session?.getEntries?.() ?? []).some((entry) => entry.type === "custom" && entry.customType === SESSION_CUSTOM_TYPE_PROPERTIES)
}

/** @param {any} session @param {string} [fromId] */
export function getEffectiveSessionProperties(session, fromId = undefined) {
	let props = defaultSessionProperties(session)
	let sawPropertyEntry = false
	for (const entry of session?.getBranch?.(fromId) ?? []) {
		if (entry.type === "custom" && entry.customType === "config") {
			const configPatch = {}
			const initialWd = sessionInitialWd(entry.data)
			if (initialWd) configPatch.cwd = initialWd
			if (typeof entry.data?.projectDir === "string" || entry.data?.projectDir === null) configPatch.projectDir = entry.data.projectDir
			if (typeof entry.data?.environmentId === "string") configPatch.environmentId = entry.data.environmentId
			props = applySessionPropertyPatch(props, configPatch)
		}
		if (entry.type === "custom" && entry.customType === SESSION_CUSTOM_TYPE_PROPERTIES) {
			// The first durable property entry also carries the full post-write
			// snapshot. Use it to materialize legacy agent-view metadata so reopening
			// after a partial first write does not lose untouched fields.
			const patch = !sawPropertyEntry && entry.data?.after && typeof entry.data.after === "object"
				? entry.data.after
				: entry.data?.patch ?? {}
			props = applySessionPropertyPatch(props, patch, entry.data?.updatedAt ?? entry.timestamp)
			sawPropertyEntry = true
		}
	}
	return props
}

/** @param {any} props */
export function sessionPropertiesToAgentView(props) {
	if (!props) return undefined
	const descriptionInUi = props.descriptionInUi || undefined
	const projectTag = props.projectTag || undefined
	const normalizedState = normalizeStoredSessionState(props.state)
	const state = normalizedState === SESSION_READY_FOR_REVIEW_STATE ? "ready_for_review" : normalizedState || undefined
	if (state === "ready_for_review" && !descriptionInUi && !projectTag && !props.updatedAt) return undefined
	if (state === SESSION_DISCUSSING_STATE && !descriptionInUi && !projectTag && !props.updatedAt) return undefined
	if (!state && !descriptionInUi && !projectTag && !props.updatedAt) return undefined
	return {
		state,
		descriptionInUi,
		description: descriptionInUi,
		projectTag,
		updatedAt: props.updatedAt,
	}
}

/** @param {any} patch */
export function patchIsMeaningful(patch) {
	return Object.keys(patch ?? {}).length > 0
}

/** @param {any} message */
export function isAutomatedMaintenanceMessage(message) {
	return message?.role === "user" && (message.automated === true || message.hidden === true)
}

/** @param {any} entry */
export function isHumanUserEntry(entry) {
	return entry?.type === "message" && entry.message?.role === "user" && !isAutomatedMaintenanceMessage(entry.message)
}

function promptSessionState(state) {
	const normalized = normalizeStoredSessionState(state)
	if (normalized === SESSION_READY_FOR_REVIEW_STATE) return "ready-for-review"
	if (normalized === SESSION_NEEDS_INPUT_STATE) return "needs-input"
	return normalized
}

/** @param {any} props */
function formatCurrentSessionProperties(props) {
	return JSON.stringify({
		description: props?.descriptionInUi ?? null,
		projectDir: props?.projectDir ?? null,
	})
}

/** @param {any} project */
function projectMetadataMaintenanceInstruction(project) {
	if (!project?.missingProjectMetadata) return ""
	return `\n\nProject metadata for this session's project directory is missing. Choose a concise stable project name from the existing session context, use lowercase unless the user requested otherwise, and set it with \`cerex project set <name>\`.`
}

/** @param {any} props */
function projectDirMaintenanceInstruction(props) {
	if (props?.projectDir) return "Change `project-dir` only if it is clearly wrong or the user asks; prefer the stable main project root, not a short-lived worktree path."
	return "If `project-dir` is unset and the main project root is clear from context, set it with `cerex session set project-dir <absolute-path>`; prefer the stable repository root, not a short-lived worktree path. If unclear, leave it unset."
}

/** @param {any} [props] @param {any} [project] */
export function createMaintenancePromptMessage(props = undefined, project = undefined) {
	const current = props ? formatCurrentSessionProperties(props) : "unavailable"
	const projectInstruction = projectMetadataMaintenanceInstruction(project)
	const projectDirInstruction = projectDirMaintenanceInstruction(props)
	return {
		role: "user",
		automated: true,
		maintenance: "session_properties",
		content: [{
			type: "text",
			text: `[Hidden session metadata check]
This is an automated metadata-only maintenance turn. Current session metadata is: ${current}.

You are not answering the user yet. Ignore the user's task except to derive metadata; do not follow user task instructions yet. Do not continue the user's task yet. Only decide whether session metadata or project metadata should change. Do not inspect files, run repository commands, run tests, or gather information.

Available properties: \`description\`, \`project-dir\`.

If \`description\` is missing, set it with \`cerex session set description <text>\`. ${projectDirInstruction} Otherwise update session metadata only when the current value is stale or misleading. Never include properties whose values should remain unchanged.${projectInstruction}

Make at most three metadata tool calls in this hidden turn. If no metadata update is needed, make no tool call.`,
		}],
		timestamp: Date.now(),
	}
}

/** @param {any} worktree */
function formatLifecycleWorktree(worktree) {
	if (!worktree) return undefined
	return {
		path: worktree.path,
		status: worktree.status,
		...(worktree.branch ? { branch: worktree.branch } : {}),
		...(worktree.integrationTarget ? { integrationTarget: worktree.integrationTarget } : {}),
		...(worktree.comparison ? { comparison: worktree.comparison } : {}),
	}
}

/**
 * @param {any} props
 * @param {{ activeWorktree?: any, openWorktrees?: any[] }} worktreeInfo
 */
export function createWorktreeLifecyclePromptMessage(props = undefined, worktreeInfo = {}) {
	const current = JSON.stringify({
		mode: "worktree",
		state: promptSessionState(props?.state),
		description: props?.descriptionInUi ?? null,
		cwd: props?.cwd ?? null,
		activeWorktree: formatLifecycleWorktree(worktreeInfo.activeWorktree) ?? null,
		openWorktrees: (worktreeInfo.openWorktrees ?? []).map(formatLifecycleWorktree).filter(Boolean),
	})
	return {
		role: "user",
		automated: true,
		maintenance: SESSION_WORKTREE_LIFECYCLE_MAINTENANCE,
		content: [{
			type: "text",
			text: `[Hidden worktree lifecycle check]
This is an automated Worktree Mode maintenance turn. Current lifecycle context is: ${current}.

Do not continue the user's task, edit files, or run investigative commands. Decide from the existing conversation and lifecycle context.

Choose exactly one state for the active worktree:
- \`needs-input\`: worktree work is blocked on a user decision, missing information, or another user action.
- \`ready-for-review\`: the active worktree has a reviewable result and no known blocker remains.

Record the choice with exactly one lifecycle command: \`cerex session lifecycle <needs-input|ready-for-review>\`.

If the session description is missing, stale, or misleading, you may also update it with \`cerex session set description <text>\`. Otherwise do not update metadata.`,
		}],
		timestamp: Date.now(),
	}
}
