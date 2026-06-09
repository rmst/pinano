import { createHash } from "node:crypto"
import { dirname } from "node:path"

import { contextFileIdentityPath } from "../session-manager/context-identity.js"

export { hasProjectContextMessage, isProjectContextMessage } from "./project-context-message.js"

/** Heading used in the synthetic project-context user message. */
export const PROJECT_CONTEXT_HEADING = "# AGENTS.md / CLAUDE.md context"

/** Heading used by the legacy lazy-loader notice inside tool results. */
export const LAZY_NOTICE_HEADING = "# Additional project context (loaded on demand)"

/** @param {string} content */
export function hashContextContent(content) {
	return createHash("sha256").update(content).digest("hex")
}

/** @param {{ path: string, content: string, scopeDir?: string, identityPath?: string, hash?: string }} file */
export function normalizeContextFile(file) {
	return {
		path: file.path,
		scopeDir: file.scopeDir ?? dirname(file.path),
		identityPath: file.identityPath ?? contextFileIdentityPath(file.path),
		content: file.content ?? "",
		hash: file.hash ?? hashContextContent(file.content ?? ""),
	}
}

/** @param {Array<{ path: string, content: string, scopeDir?: string, identityPath?: string, hash?: string }>} files */
export function normalizeContextFiles(files) {
	return files.map(normalizeContextFile)
}

/** Wrap loaded context files in the canonical model-visible envelope.
 * @param {Array<{ path: string, content: string }>} files
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

/** @param {Array<{ path: string, content: string }>} files @param {string} cwd */
export function buildContextBundleMessage(files, cwd) {
	if (!files.length) return null
	return {
		role: "user",
		content: [{ type: "text", text: formatContextFilesAsUserMessage(files, cwd) }],
		timestamp: Date.now(),
		projectContext: true,
	}
}

/** @param {any} message @returns {string[]} */
export function messageTextBlocks(message) {
	const content = message?.content
	if (Array.isArray(content)) {
		return content
			.filter((block) => block?.type === "text" && typeof block.text === "string")
			.map((block) => block.text)
	}
	if (typeof content === "string") return [content]
	return []
}
