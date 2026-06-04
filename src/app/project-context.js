// AGENTS.md / CLAUDE.md startup loading.
//
// Project instructions are durable session context, not conversation. New
// sessions record an exact context-load entry anchored in the session tree;
// prompt assembly injects the active snapshots before each model call. The
// legacy synthetic user-message helpers stay exported for old sessions and
// hermetic print mode.

import { homedir } from "node:os"
import { join } from "node:path"

import { loadProjectContextFiles } from "./context-files.js"
import {
	PROJECT_CONTEXT_HEADING,
	formatContextFilesAsUserMessage,
	hasProjectContextMessage,
	isProjectContextMessage,
} from "./context-format.js"
import { configRoot, isPinanoTestProcess, legacyConfigRoot } from "./paths.js"

/** @typedef {import("./context-files.js").ContextFile} ContextFile */

export { PROJECT_CONTEXT_HEADING, formatContextFilesAsUserMessage, hasProjectContextMessage, isProjectContextMessage }

/** Default global agent dirs used by the session-startup path.
 * @returns {string[]} */
export function defaultAgentDirs() {
	const dirs = [configRoot(), legacyConfigRoot()]
	const home = join(homedir(), ".pinano")
	if (!isPinanoTestProcess() && !dirs.includes(home)) dirs.push(home)
	return dirs
}

/** Build a synthetic user message containing the project context, or null if
 * no AGENTS.md/CLAUDE.md was found anywhere. Used by hermetic print mode and
 * by legacy tests; normal sessions now use context-load entries instead.
 * @param {string} cwd
 * @returns {any | null} */
export function buildProjectContextMessage(cwd) {
	const files = loadProjectContextForCwd(cwd)
	if (files.length === 0) return null
	return {
		role: "user",
		content: [{ type: "text", text: formatContextFilesAsUserMessage(files, cwd) }],
		timestamp: Date.now(),
		projectContext: true,
	}
}

/** @param {string} cwd @returns {ContextFile[]} */
export function loadProjectContextForCwd(cwd) {
	return loadProjectContextFiles({ cwd, agentDirs: defaultAgentDirs() })
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
 * @returns {Promise<void>}
 */
export async function ensureProjectContextMessage(session, cwd) {
	const loads = session.getContextLoads?.() ?? []
	if (loads.some((load) => load.source === "startup")) return
	const displayMessages = session.getDisplayEntries?.().map((entry) => entry.message) ?? session.getMessages?.() ?? []
	if (hasProjectContextMessage(displayMessages)) return
	if (displayMessages.length > 0) return
	const files = loadProjectContextForCwd(cwd)
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
