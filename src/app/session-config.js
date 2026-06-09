/**
 * Durable per-session config stored in custom "config" entries.
 *
 * initialWd is the session or branch starting working directory. sandboxMounts
 * are session-specific sandbox mount entries using the same shape as
 * environment sandbox.mountPaths.
 */

/** @param {any} config */
export function sessionInitialWd(config) {
	return typeof config?.initialWd === "string" && config.initialWd ? config.initialWd : undefined
}

/** @param {any} config */
export function sessionSandboxMounts(config) {
	return Array.isArray(config?.sandboxMounts) ? config.sandboxMounts : []
}

/** @param {any} mount */
function mountFromPath(mount) {
	if (typeof mount === "string") return mount
	if (mount && typeof mount === "object" && typeof mount.from === "string") return mount.from
	return undefined
}

/** @param {any} config */
export function primarySandboxMountWd(config) {
	return sessionSandboxMounts(config).map(mountFromPath).find(Boolean)
}

/** @param {any} config @param {string | undefined} fallback */
export function sessionSandboxBaseWd(config, fallback = undefined) {
	return primarySandboxMountWd(config) ?? sessionInitialWd(config) ?? fallback
}

/** @param {any} sandbox @param {any[]} mounts */
export function sandboxWithSessionMounts(sandbox, mounts) {
	if (!sandbox?.type || sandbox.type === "none" || !Array.isArray(mounts) || mounts.length === 0) return sandbox
	const existing = sandbox.mountPaths ?? sandbox.paths ?? []
	return {
		...sandbox,
		mountPaths: [...mounts, ...existing],
	}
}
