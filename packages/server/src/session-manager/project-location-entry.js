import { isAbsolute, resolve } from "node:path"

export const PROJECT_LOCATION_CUSTOM_TYPE = "project_location_changed"
export const PROJECT_LOCATION_MESSAGE_ROLE = "projectLocation"

/** @param {unknown} value */
function absolutePath(value) {
	return typeof value === "string" && value && isAbsolute(value) ? resolve(value) : undefined
}

/** @param {any} entry */
export function projectLocationChangeFromEntry(entry) {
	if (entry?.type !== "custom" || entry.customType !== PROJECT_LOCATION_CUSTOM_TYPE) return undefined
	const data = entry.data ?? {}
	if (data.version !== 1) return undefined
	const projectId = typeof data.projectId === "string" && data.projectId ? data.projectId : undefined
	const previousRoot = absolutePath(data.previousRoot)
	const root = absolutePath(data.root)
	if (!projectId || !previousRoot || !root || previousRoot === root) return undefined
	return {
		version: 1,
		projectId,
		previousRoot,
		root,
	}
}

/** @param {any} sessionEntry @param {any} properties */
export function projectLocationChangeForSession(sessionEntry, properties) {
	const projectId = typeof sessionEntry?.projectId === "string" && sessionEntry.projectId ? sessionEntry.projectId : undefined
	const rootAtLeaf = absolutePath(sessionEntry?.projectRootAtLeaf)
	const previousRoot = absolutePath(properties?.projectDir ?? rootAtLeaf)
	const root = absolutePath(sessionEntry?.projectDir)
	// A just-appended projectDir patch can be ahead of the database projection. It is a session project change, not evidence that the linked project moved.
	if (properties?.projectDir && rootAtLeaf && previousRoot !== rootAtLeaf) return undefined
	if (!projectId || !previousRoot || !root || previousRoot === root) return undefined
	return { version: 1, projectId, previousRoot, root }
}

/** @param {any} config @param {{ previousRoot: string, root: string } | undefined} change */
export function applyProjectLocationToConfig(config, change) {
	if (!change) return config ?? {}
	return {
		...(config ?? {}),
		projectDir: change.root,
	}
}

/** @param {any} properties @param {{ previousRoot: string, root: string } | undefined} change */
export function applyProjectLocationToProperties(properties, change) {
	if (!change) return properties ?? {}
	return {
		...(properties ?? {}),
		projectDir: change.root,
	}
}

/** @param {{ previousRoot: string, root: string }} change */
function projectLocationMessageContent(change) {
	return [{
		type: "text",
		text: [
			"Cerex project location update:",
			`This same project moved from ${change.previousRoot} to ${change.root}.`,
			"The session's recorded cwd and historical absolute paths were not changed. Inspect the current state and explicitly change cwd if continued work should use the new project location.",
		].join("\n"),
	}]
}

/** @param {any} entry */
export function projectLocationModelMessageForEntry(entry) {
	const change = projectLocationChangeFromEntry(entry)
	if (!change) return undefined
	return {
		role: "developer",
		content: projectLocationMessageContent(change),
		timestamp: new Date(entry.timestamp).getTime(),
		hidden: true,
		projectLocationChanged: change,
	}
}

/** @param {any} entry */
export function projectLocationDisplayMessageForEntry(entry) {
	const change = projectLocationChangeFromEntry(entry)
	if (!change) return undefined
	return {
		role: PROJECT_LOCATION_MESSAGE_ROLE,
		content: projectLocationMessageContent(change),
		timestamp: new Date(entry.timestamp).getTime(),
		projectLocationChanged: change,
	}
}
