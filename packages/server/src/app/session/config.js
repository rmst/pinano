import { statSync } from "node:fs"

/**
 * Durable per-session config stored in custom "config" entries.
 *
 * initialWd is immutable history: the working directory where this session or branch began. sandboxMounts are explicit session-specific additions using the same shape as environment sandbox.mountPaths. Relative mounts are resolved from the current canonical project directory when one exists, otherwise initialWd; persisted mounts are never rewritten when either location changes.
 */

/** @param {any} config */
export function sessionInitialWd(config) {
	return typeof config?.initialWd === "string" && config.initialWd ? config.initialWd : undefined
}

/** @param {any} config */
export function sessionSandboxMounts(config) {
	return Array.isArray(config?.sandboxMounts) ? config.sandboxMounts : []
}

/** @param {any[]} explicitMounts @param {string | undefined} cwd */
export function sandboxMountsForRuntime(explicitMounts, cwd = undefined) {
	const mounts = Array.isArray(explicitMounts) ? explicitMounts : []
	if (!cwd) return mounts
	try {
		if (!statSync(cwd).isDirectory()) return mounts
	} catch {
		return mounts
	}
	// cwd is explicit session state, so an existing checkout must remain accessible even when projectDir points at the canonical main checkout. Missing historical cwd values are left untouched and omitted rather than repaired.
	return [cwd, ...mounts]
}

/** @param {any} config @param {string | undefined} projectDir @param {string | undefined} fallback */
export function sessionSandboxBaseWd(config, projectDir = undefined, fallback = undefined) {
	return projectDir ?? sessionInitialWd(config) ?? fallback
}

/** @param {any} sandbox @param {any[]} mounts @param {string | undefined} projectDir */
export function sandboxWithSessionMounts(sandbox, mounts, projectDir = undefined) {
	if (!sandbox?.type || sandbox.type === "none") return sandbox
	const existing = sandbox.mountPaths ?? []
	const projectMounts = projectDir ? [projectDir] : []
	const sessionMounts = Array.isArray(mounts) ? mounts : []
	if (projectMounts.length === 0 && sessionMounts.length === 0) return sandbox
	return {
		...sandbox,
		// Project access is derived from current project identity at runtime. It is deliberately not persisted as an absolute path, so a project move changes the effective mount without rewriting session history.
		mountPaths: [...projectMounts, ...sessionMounts, ...existing],
	}
}
