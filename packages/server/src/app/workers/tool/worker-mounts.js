import { isAbsolute, resolve } from "node:path"

import { effectiveSandboxMounts, hostPathForMountedPath, mountedPathForHostPath } from "../../sandbox/paths.js"
import { addSessionWorkspaceRootMount } from "./state-mounts.js"

/** Resolve the filesystem view shared with a local tool worker. */
export function workerSandboxMounts(workerContext = {}) {
	const sandbox = workerContext.sandbox ?? { type: "none" }
	const mounts = effectiveSandboxMounts({
		sessionWd: workerContext.sessionWd ?? workerContext.startCwd,
		useSessionWd: sandbox.useSessionWd ?? true,
		mountPaths: sandbox.mountPaths ?? [],
	}, "Worker path mapping")
	return addSessionWorkspaceRootMount(mounts, typeof workerContext.sessionDir === "string" ? workerContext.sessionDir : undefined)
}

export function hostPathForWorkerPath(workerPath, workerContext = {}) {
	if (typeof workerPath !== "string" || !workerPath || !isAbsolute(workerPath)) return undefined
	if (workerContext.target?.type !== "local") return undefined
	const sandbox = workerContext.sandbox ?? { type: "none" }
	if (sandbox.type === "none") return { path: resolve(workerPath), readOnly: false }
	if (sandbox.type !== "native" && sandbox.type !== "container") return undefined
	try {
		return hostPathForMountedPath(workerSandboxMounts(workerContext), workerPath)
	} catch {
		return undefined
	}
}

/** Narrow an existing worker-visible host path to one exact mount without carrying unrelated worker mounts forward. */
export function workerSandboxMountForHostPath(hostPath, workerContext = {}, options = {}) {
	if (typeof hostPath !== "string" || !hostPath || !isAbsolute(hostPath)) return undefined
	if (workerContext.target?.type !== "local") return undefined
	const path = resolve(hostPath)
	const sandbox = workerContext.sandbox ?? { type: "none" }
	if (sandbox.type === "none") return { from: path, to: path, readOnly: options.readOnly === true }
	if (sandbox.type !== "native" && sandbox.type !== "container") return undefined
	try {
		const mapped = mountedPathForHostPath(workerSandboxMounts(workerContext), path)
		if (!mapped) return undefined
		return { from: path, to: mapped.path, readOnly: mapped.readOnly || options.readOnly === true }
	} catch {
		return undefined
	}
}
