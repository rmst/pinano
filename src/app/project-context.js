// AGENTS.md / CLAUDE.md delivery as a user message (Codex / Claude Code pattern).
//
// Pi (and pinano's earlier implementation) put project context into the system
// prompt. Codex (OpenAI) and Claude Code both deliver it as a user message
// after the system prompt instead, with a structured wrapper. We follow that
// convention here. Rationale:
//
//   - Cache locality: editing AGENTS.md no longer invalidates the system
//     prompt cache — only the prefix from the user-message onwards.
//   - Conceptual separation: the system prompt holds agent identity and
//     behavioral norms; user-message content holds user/project preferences.
//   - Indistinguishability fix: the wrapped `# AGENTS.md / CLAUDE.md context
//     for <cwd>\n<INSTRUCTIONS>...</INSTRUCTIONS>` envelope makes it clear to
//     the model where the user-provided rules begin and end.
//
// Freeze semantics: the message is appended to the session's JSONL on first
// session creation. On resume, the persisted message replays verbatim — disk
// is NOT re-read. This matches Codex CLI's `rollout_reconstruction.rs`
// behavior. To pick up edits to a top-level AGENTS.md, start a new session.
// Pinano-divergence vs pi (which re-reads on every startup).

import { homedir } from "node:os"
import { join } from "node:path"

import { loadProjectContextFiles } from "./context-files.js"
import { configRoot } from "./paths.js"

/** @typedef {import("./context-files.js").ContextFile} ContextFile */

/** Heading used in the synthetic user message; also the marker we look for
 * when deciding whether a session already has its context injected. */
export const PROJECT_CONTEXT_HEADING = "# AGENTS.md / CLAUDE.md context"

/** Default global agent dirs used by the session-startup path.
 * @returns {string[]} */
export function defaultAgentDirs() {
	return [configRoot(), join(homedir(), ".pinano")]
}

/** Wrap the loaded context files in a Codex-style envelope.
 * @param {ContextFile[]} files
 * @param {string} cwd
 * @returns {string} */
export function formatContextFilesAsUserMessage(files, cwd) {
	let out = `${PROJECT_CONTEXT_HEADING} for ${cwd}\n\n<INSTRUCTIONS>\n`
	out += `Project-specific instructions and guidelines, listed in priority order (root-most first, cwd last):\n\n`
	for (const { path, content } of files) {
		out += `## ${path}\n\n${content}\n\n`
	}
	out += `</INSTRUCTIONS>`
	return out
}

/** Build a synthetic user message containing the project context, or null if
 * no AGENTS.md/CLAUDE.md was found anywhere.
 * @param {string} cwd
 * @returns {any | null} */
export function buildProjectContextMessage(cwd) {
	const files = loadProjectContextFiles({ cwd, agentDirs: defaultAgentDirs() })
	if (files.length === 0) return null
	return {
		role: "user",
		content: [{ type: "text", text: formatContextFilesAsUserMessage(files, cwd) }],
		timestamp: Date.now(),
	}
}

/** True iff `m` is the synthetic project-context user message we inject at
 * session creation. Used to filter it out of session-emptiness checks and the
 * /fork rewind picker, where it would otherwise look like a real user turn.
 * @param {any} m
 * @returns {boolean} */
export function isProjectContextMessage(m) {
	if (m?.role !== "user") return false
	const content = m.content
	if (Array.isArray(content)) {
		return content.some(
			(/** @type {any} */ c) => c?.type === "text" && typeof c.text === "string" && c.text.includes(PROJECT_CONTEXT_HEADING),
		)
	}
	if (typeof content === "string") return content.includes(PROJECT_CONTEXT_HEADING)
	return false
}

/** Detect whether a session's messages already contain the project-context
 * envelope (i.e. it was injected previously and we should freeze).
 * @param {ReadonlyArray<any>} messages
 * @returns {boolean} */
export function hasProjectContextMessage(messages) {
	return messages.some(isProjectContextMessage)
}

/**
 * Append a synthetic project-context user message to `session` if one isn't
 * already present. Idempotent: safe to call on resumed sessions (which
 * already have the message in history) and on legacy sessions (which append
 * once and then freeze).
 *
 * @param {any} session
 * @param {string} cwd
 * @returns {Promise<void>}
 */
export async function ensureProjectContextMessage(session, cwd) {
	if (hasProjectContextMessage(session.getMessages())) return
	const msg = buildProjectContextMessage(cwd)
	if (!msg) return
	await session.appendMessage(msg)
}
