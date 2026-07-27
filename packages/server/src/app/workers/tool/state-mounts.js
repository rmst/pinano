import { dirname } from "node:path"

import { addReadOnlyMountUnlessCovered, addWritableMountUnlessCovered, hostPathForMountedPath, minimizeCoveredMounts, mountedPathForHostPath } from "../../sandbox/paths.js"

export const STATE_MOUNT_READ_ONLY = "readOnly"
export const STATE_MOUNT_READ_WRITE = "readWrite"

/** @typedef {false | typeof STATE_MOUNT_READ_ONLY | typeof STATE_MOUNT_READ_WRITE} StateMountMode */

/** @param {unknown} value @returns {StateMountMode | undefined} */
export function normalizeStateMount(value) {
	if (value === undefined || value === null || value === false) return false
	if (value === true) return STATE_MOUNT_READ_ONLY
	if (typeof value !== "string") return undefined
	const normalized = value.trim().toLowerCase()
	if (!normalized || ["false", "off", "none", "no"].includes(normalized)) return false
	if (["readonly", "read-only", "read_only", "ro"].includes(normalized)) return STATE_MOUNT_READ_ONLY
	if (["readwrite", "read-write", "read_write", "rw"].includes(normalized)) return STATE_MOUNT_READ_WRITE
	return undefined
}

/** @param {unknown} mode */
export function stateMountEnabled(mode) {
	return mode === STATE_MOUNT_READ_ONLY || mode === STATE_MOUNT_READ_WRITE
}

/**
 * @param {any[]} mounts
 * @param {string | undefined} stateDirPath
 * @param {unknown} stateMount
 */
export function addStateDirectoryMount(mounts, stateDirPath, stateMount) {
	const mode = normalizeStateMount(stateMount)
	if (!stateDirPath || !stateMountEnabled(mode)) return mounts
	return mode === STATE_MOUNT_READ_WRITE
		? addWritableMountUnlessCovered(mounts, stateDirPath)
		: addReadOnlyMountUnlessCovered(mounts, stateDirPath)
}

/**
 * @param {any[]} mounts
 * @param {string | undefined} sessionDir
 */
export function addSessionWorkspaceRootMount(mounts, sessionDir) {
	return sessionDir ? addWritableMountUnlessCovered(mounts, dirname(sessionDir)) : mounts
}

/**
 * @param {any[]} mounts
 * @param {string | undefined} runtimeSourceReferencePath
 */
export function addRuntimeSourceReferenceMount(mounts, runtimeSourceReferencePath) {
	return runtimeSourceReferencePath ? addReadOnlyMountUnlessCovered(mounts, runtimeSourceReferencePath, { requireOneToOneMapping: true }) : mounts
}

/**
 * @param {any[]} mounts
 * @param {string | undefined} hostHomePath
 * @param {string | undefined} containerHomePath
 */
export function addManagedContainerHomeMount(mounts, hostHomePath, containerHomePath) {
	if (!hostHomePath || !containerHomePath) return mounts
	const existingHomeMount = mountedPathForHostPath(mounts, hostHomePath)
	if (existingHomeMount && !existingHomeMount.readOnly && existingHomeMount.path === containerHomePath) return mounts
	const targetConflict = hostPathForMountedPath(mounts, containerHomePath)
	if (targetConflict) {
		const mount = targetConflict.mount
		const formatted = `${mount.from}${mount.to !== mount.from ? ` -> ${mount.to}` : ""}`
		throw new Error(`Managed container isolated HOME path ${containerHomePath} is already covered by sandbox mount: ${formatted}`)
	}
	return minimizeCoveredMounts([...mounts, { from: hostHomePath, to: containerHomePath, readOnly: false }])
}

/**
 * @param {any[]} mounts
 * @param {{ sessionDir?: string, stateDirPath?: string, stateMount?: unknown, runtimeSourceReferencePath?: string }} options
 */
export function addImplicitStateMounts(mounts, options = {}) {
	let next = addStateDirectoryMount(mounts, options.stateDirPath, options.stateMount)
	next = addSessionWorkspaceRootMount(next, options.sessionDir)
	return addRuntimeSourceReferenceMount(next, options.runtimeSourceReferencePath)
}
