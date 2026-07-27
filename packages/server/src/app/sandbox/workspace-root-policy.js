import { realpath, stat } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"

import { optionalSessionWorkspacesRoot } from "../paths.js"
import { pathIsWithin } from "./paths.js"

function policyError(message, status = 400) {
	return Object.assign(new Error(message), { status })
}

function cleanAbsolutePath(value, label) {
	const text = typeof value === "string" ? value.trim() : ""
	if (!text) throw policyError(`${label} must be a non-empty absolute path`)
	if (!isAbsolute(text)) throw policyError(`${label} must be an absolute path`)
	return resolve(text)
}

async function realDirectoryPath(value, label) {
	const path = cleanAbsolutePath(value, label)
	let real
	try {
		real = resolve(await realpath(path))
	} catch (err) {
		if (err?.code === "ENOENT") throw Object.assign(policyError(`${label} does not exist: ${path}`), { code: "ENOENT" })
		throw err
	}
	let info
	try {
		info = await stat(real)
	} catch (err) {
		if (err?.code === "ENOENT") throw Object.assign(policyError(`${label} does not exist: ${path}`), { code: "ENOENT" })
		throw err
	}
	if (!info.isDirectory()) throw policyError(`${label} must be a directory: ${path}`)
	return real
}

async function optionalRealDirectoryPath(value) {
	if (!value) return undefined
	try {
		return await realDirectoryPath(value, "Cerex session workspace root")
	} catch (err) {
		if (err?.code === "ENOENT") return undefined
		throw err
	}
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function workspaceRootFromSettingsValue(value) {
	return typeof value === "string" && value.trim() ? value.trim() : undefined
}

/**
 * @param {Pick<import("../settings.js").Settings, "service"> | undefined} settings
 * @returns {string | undefined}
 */
export function workspaceRootFromSettings(settings) {
	return workspaceRootFromSettingsValue(settings?.service?.workspaceRoot)
}

/**
 * @typedef {object} WorkspaceRootPolicy
 * @property {string} root
 * @property {string} configuredRoot
 * @property {(cwd: string, label?: string) => Promise<string>} normalizeUserCwd
 * @property {(cwd: string, label?: string) => Promise<string>} normalizeStoredCwd
 * @property {(cwd: string) => Promise<boolean>} allowsExistingCwd
 * @property {(cwd: string) => Promise<boolean>} allowsServiceOwnedCwd
 * @property {(cwd: string) => Promise<boolean>} allowsStoredCwd
 */

/**
 * @param {string | undefined} workspaceRoot
 * @returns {Promise<WorkspaceRootPolicy | undefined>}
 */
export async function createWorkspaceRootPolicy(workspaceRoot) {
	const configuredRoot = workspaceRootFromSettingsValue(workspaceRoot)
	if (!configuredRoot) return undefined
	const root = await realDirectoryPath(configuredRoot, "service.workspaceRoot")
	let serviceOwnedRoot

	const normalizeUserCwd = async (cwd, label = "cwd") => {
		const real = await realDirectoryPath(cwd, label)
		if (!pathIsWithin(root, real)) {
			throw policyError(`${label} must be inside configured service.workspaceRoot (${root}): ${resolve(cwd)}`)
		}
		return real
	}

	const allowsExistingCwd = async (cwd) => {
		try {
			await normalizeUserCwd(cwd)
			return true
		} catch {
			return false
		}
	}

	const normalizeServiceOwnedCwd = async (cwd, label = "cwd") => {
		if (!serviceOwnedRoot) serviceOwnedRoot = await optionalRealDirectoryPath(optionalSessionWorkspacesRoot())
		if (!serviceOwnedRoot) return undefined
		const real = await realDirectoryPath(cwd, label)
		return pathIsWithin(serviceOwnedRoot, real) ? real : undefined
	}

	const normalizeStoredCwd = async (cwd, label = "cwd") => {
		try {
			return await normalizeUserCwd(cwd, label)
		} catch (err) {
			const serviceOwned = await normalizeServiceOwnedCwd(cwd, label).catch(() => undefined)
			if (serviceOwned) return serviceOwned
			throw err
		}
	}

	const allowsServiceOwnedCwd = async (cwd) => !!await normalizeServiceOwnedCwd(cwd, "session cwd").catch(() => undefined)

	const allowsStoredCwd = async (cwd) => !!await normalizeStoredCwd(cwd).catch(() => undefined)

	return {
		root,
		configuredRoot,
		normalizeUserCwd,
		normalizeStoredCwd,
		allowsExistingCwd,
		allowsServiceOwnedCwd,
		allowsStoredCwd,
	}
}

/**
 * @param {Pick<import("../settings.js").Settings, "service"> | undefined} settings
 * @returns {Promise<WorkspaceRootPolicy | undefined>}
 */
export async function createWorkspaceRootPolicyFromSettings(settings) {
	return createWorkspaceRootPolicy(workspaceRootFromSettings(settings))
}
