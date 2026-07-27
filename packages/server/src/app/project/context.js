// AGENTS.md / CLAUDE.md startup loading.
//
// Project instructions are durable session context, not conversation. New
// sessions record an exact context-load entry anchored in the session tree;
// prompt assembly injects the active snapshots before each model call. The
// legacy synthetic user-message helpers stay exported for old sessions.

import { loadGlobalContextFiles } from "../context/files.js"
import {
	PROJECT_CONTEXT_HEADING,
	formatContextFilesAsUserMessage,
	hasProjectContextMessage,
	isProjectContextMessage,
} from "../context/format.js"
import { productHomePath } from "../paths.js"
import { contextFileIdentity } from "../../session-manager/context-identity.js"

/** @typedef {import("../context/files.js").ContextFile} ContextFile */

export { PROJECT_CONTEXT_HEADING, formatContextFilesAsUserMessage, hasProjectContextMessage, isProjectContextMessage }

/** Default global agent dirs used by the session-startup path.
 * @returns {string[]} */
export function defaultAgentDirs() {
	return [productHomePath()]
}

/** @param {string} cwd @param {any} workspace @returns {Promise<ContextFile[]>} */
export async function loadProjectContext(cwd, workspace) {
	if (typeof workspace?.context?.loadProject !== "function") throw new TypeError("Project context loading requires a workspace client")
	const files = [
		...loadGlobalContextFiles(defaultAgentDirs()),
		...await workspace.context.loadProject(cwd),
	]
	const seen = new Set()
	return files.filter((file) => {
		const key = contextFileIdentity(file)
		if (seen.has(key)) return false
		seen.add(key)
		return true
	})
}

/**
 * Record the startup project-context snapshot for an empty newly-created
 * session if this branch has not already attempted startup context loading.
 * Empty loads are recorded too: “no files existed when the session started” is
 * part of the frozen session state. Existing non-empty sessions keep their
 * previous context representation.
 *
 * @param {any} session
 * @param {string} cwd
 * @param {any} workspace
 * @returns {Promise<void>}
 */
export async function ensureProjectContextMessage(session, cwd, workspace) {
	const loads = session.getContextLoads?.() ?? []
	if (loads.some((load) => load.source === "startup")) return
	const displayMessages = session.getDisplayEntries?.().map((entry) => entry.message) ?? session.getMessages?.() ?? []
	if (hasProjectContextMessage(displayMessages)) return
	if (displayMessages.length > 0) return
	const files = await loadProjectContext(cwd, workspace)
	if (session.appendContextLoad) {
		await session.appendContextLoad({ source: "startup", cwd, files })
		return
	}

	// Compatibility fallback for tiny test doubles / non-session callers.
	if (files.length === 0) return
	await session.appendMessage({
		role: "user",
		content: [{ type: "text", text: formatContextFilesAsUserMessage(files, cwd) }],
		timestamp: Date.now(),
		projectContext: true,
	})
}
