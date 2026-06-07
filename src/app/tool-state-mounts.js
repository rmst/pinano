import { dirname } from "node:path"

import { addReadOnlyMountUnlessCovered, addWritableMountUnlessCovered } from "./sandbox-paths.js"

export const PINANO_STATE_MOUNT_READ_ONLY = "readOnly"
export const PINANO_STATE_MOUNT_READ_WRITE = "readWrite"

/** @typedef {false | typeof PINANO_STATE_MOUNT_READ_ONLY | typeof PINANO_STATE_MOUNT_READ_WRITE} PinanoStateMountMode */

/** @param {unknown} value @returns {PinanoStateMountMode | undefined} */
export function normalizePinanoStateMount(value) {
	if (value === undefined || value === null || value === false) return false
	if (value === true) return PINANO_STATE_MOUNT_READ_ONLY
	if (typeof value !== "string") return undefined
	const normalized = value.trim().toLowerCase()
	if (!normalized || ["false", "off", "none", "no"].includes(normalized)) return false
	if (["readonly", "read-only", "read_only", "ro"].includes(normalized)) return PINANO_STATE_MOUNT_READ_ONLY
	if (["readwrite", "read-write", "read_write", "rw"].includes(normalized)) return PINANO_STATE_MOUNT_READ_WRITE
	return undefined
}

/** @param {unknown} mode */
export function pinanoStateMountEnabled(mode) {
	return mode === PINANO_STATE_MOUNT_READ_ONLY || mode === PINANO_STATE_MOUNT_READ_WRITE
}

/**
 * @param {any[]} mounts
 * @param {string | undefined} pinanoStateDirPath
 * @param {unknown} pinanoStateMount
 */
export function addPinanoStateDirMount(mounts, pinanoStateDirPath, pinanoStateMount) {
	const mode = normalizePinanoStateMount(pinanoStateMount)
	if (!pinanoStateDirPath || !pinanoStateMountEnabled(mode)) return mounts
	return mode === PINANO_STATE_MOUNT_READ_WRITE
		? addWritableMountUnlessCovered(mounts, pinanoStateDirPath)
		: addReadOnlyMountUnlessCovered(mounts, pinanoStateDirPath)
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
 * @param {{ sessionDir?: string, pinanoStateDirPath?: string, pinanoStateMount?: unknown, runtimeSourceReferencePath?: string }} options
 */
export function addImplicitPinanoStateMounts(mounts, options = {}) {
	let next = addPinanoStateDirMount(mounts, options.pinanoStateDirPath, options.pinanoStateMount)
	next = addSessionWorkspaceRootMount(next, options.sessionDir)
	return addRuntimeSourceReferenceMount(next, options.runtimeSourceReferencePath)
}
