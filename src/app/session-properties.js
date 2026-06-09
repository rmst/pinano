import { isAbsolute } from "node:path"

import { sessionInitialWd } from "./session-config.js"

export const SESSION_CUSTOM_TYPE_PROPERTIES = "session_properties"
// Provider function-tool names cannot contain dots. `sessionWrite` is the
// model-facing tool for Pinano's session property write operation.
export const SESSION_SET_TOOL_NAME = "sessionWrite"

export const SESSION_READY_FOR_REVIEW_STATE = "readyForReview"
export const SESSION_PROPERTY_STATES = [SESSION_READY_FOR_REVIEW_STATE, "needs_input", "completed", "deferred"]
export const SESSION_MODEL_WRITABLE_STATES = [SESSION_READY_FOR_REVIEW_STATE, "needs_input", "completed"]
const SESSION_PROPERTY_KEYS = ["state", "descriptionInUi", "projectTag", "cwd", "environmentId"]
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

/**
 * @param {any} patch
 * @param {{ allowEmpty?: boolean, allowedStates?: string[], allowNullState?: boolean }} [options]
 */
export function normalizeSessionPropertyPatch(patch, options = {}) {
	if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new TypeError("sessionWrite expects an object")
	const unknown = Object.keys(patch).filter((key) => !SESSION_PROPERTY_KEY_SET.has(key))
	if (unknown.length > 0) throw new TypeError(`Unknown session property field(s): ${unknown.join(", ")}`)
	if (!options.allowEmpty && Object.keys(patch).length === 0) throw new TypeError("sessionWrite expects at least one property")
	const allowedStates = options.allowedStates ?? SESSION_MODEL_WRITABLE_STATES
	const allowedStateSet = new Set(allowedStates)
	const allowNullState = options.allowNullState !== false
	const allowedStateDescription = allowedStates.join(", ")
	const out = {}
	if (Object.prototype.hasOwnProperty.call(patch, "state")) {
		if ((patch.state === null || patch.state === "null") && allowNullState) out.state = SESSION_READY_FOR_REVIEW_STATE
		else if (typeof patch.state === "string" && allowedStateSet.has(patch.state)) out.state = patch.state
		else throw new TypeError(`state must be one of ${allowedStateDescription}`)
	}
	if (Object.prototype.hasOwnProperty.call(patch, "descriptionInUi")) out.descriptionInUi = cleanNullableText(patch.descriptionInUi, "descriptionInUi", 160)
	if (Object.prototype.hasOwnProperty.call(patch, "projectTag")) out.projectTag = cleanProjectTag(patch.projectTag)
	if (Object.prototype.hasOwnProperty.call(patch, "cwd")) {
		const cwd = cleanRequiredString(patch.cwd, "cwd")
		if (!isAbsolute(cwd)) throw new TypeError("cwd must be an absolute path")
		out.cwd = cwd
	}
	if (Object.prototype.hasOwnProperty.call(patch, "environmentId")) out.environmentId = cleanRequiredString(patch.environmentId, "environmentId")
	return out
}

/** @param {any} session */
function normalizeStoredSessionState(state) {
	return state === undefined || state === null || state === "null" || state === "ready_for_review"
		? SESSION_READY_FOR_REVIEW_STATE
		: state
}

export function defaultSessionProperties(session) {
	return {
		state: normalizeStoredSessionState(session?.legacySessionProperties?.state),
		descriptionInUi: session?.legacySessionProperties?.descriptionInUi ?? session?.legacySessionProperties?.description,
		projectTag: session?.legacySessionProperties?.projectTag,
		cwd: session?.legacySessionProperties?.cwd ?? session?.getMetadata?.().cwd ?? process.cwd(),
		environmentId: session?.legacySessionProperties?.environmentId ?? "local",
		updatedAt: session?.legacySessionProperties?.updatedAt,
	}
}

/** @param {any} base @param {any} patch @param {string | undefined} updatedAt */
export function applySessionPropertyPatch(base, patch, updatedAt = undefined) {
	const next = { ...base }
	for (const [key, value] of Object.entries(patch ?? {})) next[key] = key === "state" ? normalizeStoredSessionState(value) : value === null ? null : value
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
	const state = normalizeStoredSessionState(props.state) === SESSION_READY_FOR_REVIEW_STATE ? "ready_for_review" : props.state || undefined
	if (state === "ready_for_review" && !descriptionInUi && !projectTag && !props.updatedAt) return undefined
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
	return message?.role === "user" && (message.pinanoAutomated === true || message.pinanoHidden === true)
}

/** @param {any} entry */
export function isHumanUserEntry(entry) {
	return entry?.type === "message" && entry.message?.role === "user" && !isAutomatedMaintenanceMessage(entry.message)
}

const sessionPropertyPromptKeys = ["state", "descriptionInUi", "projectTag"]

/** @param {any} props */
function formatCurrentSessionProperties(props) {
	const current = Object.fromEntries(sessionPropertyPromptKeys
		.map((key) => [key, key === "state" ? normalizeStoredSessionState(props?.state) : props?.[key] ?? null]))
	return JSON.stringify(current)
}

/** @param {any} props */
function metadataMaintenanceInstruction(props) {
	if (props && (!props.descriptionInUi || !props.projectTag)) return "projectTag and descriptionInUi must be updated using sessionWrite."
	return "Update projectTag or descriptionInUi only if they are stale or misleading."
}

/** @param {any} [props] */
export function createMaintenancePromptMessage(props = undefined) {
	const current = props ? formatCurrentSessionProperties(props) : "unavailable"
	const instruction = metadataMaintenanceInstruction(props)
	return {
		role: "user",
		pinanoAutomated: true,
		pinanoMaintenance: "session_properties",
		content: [{
			type: "text",
			text: `[Hidden session metadata check]\nPrevious session metadata was: ${current}. ${instruction} With sessionWrite never include fields whose values should remain unchanged!`,
		}],
		timestamp: Date.now(),
	}
}
