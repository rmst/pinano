// Centralized path resolution for Cerex on-disk state.

import { existsSync, readFileSync, realpathSync, renameSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { LEGACY_PRODUCT_STATE_DIRECTORY, PRODUCT_STATE_DIRECTORY, readProductEnv } from "../../../protocol/src/product.js"
import { safePathComponent, sessionWorkspaceDirName } from "./session/workspace-names.js"

function pathsReferToSameDirectory(left, right) {
	try {
		return realpathSync(left) === realpathSync(right)
	} catch {
		return false
	}
}

function legacyServiceAppearsActive(home) {
	try {
		const info = JSON.parse(readFileSync(join(home, "data", "services", "global", "service.json"), "utf-8"))
		const pid = Number(info?.pid)
		if (!Number.isInteger(pid) || pid <= 0) return false
		process.kill(pid, 0)
		return true
	} catch (err) {
		return err?.code === "EPERM"
	}
}

function defaultProductHome() {
	const canonical = join(homedir(), PRODUCT_STATE_DIRECTORY)
	const legacy = join(homedir(), LEGACY_PRODUCT_STATE_DIRECTORY)
	const canonicalExists = existsSync(canonical)
	const legacyExists = existsSync(legacy)
	if (canonicalExists && legacyExists) {
		if (pathsReferToSameDirectory(canonical, legacy)) return canonical
		throw new Error(`Both ${canonical} and legacy ${legacy} exist. Merge or remove one before starting Cerex; Cerex will not choose between two state directories.`)
	}
	if (canonicalExists || !legacyExists) return canonical
	if (legacyServiceAppearsActive(legacy)) {
		throw new Error(`Legacy state exists at ${legacy}, but its service still appears to be running. Stop it with \`pinano service stop\`, then start Cerex again to migrate the state to ${canonical}.`)
	}
	try {
		renameSync(legacy, canonical)
	} catch (err) {
		throw new Error(`Could not migrate legacy state from ${legacy} to ${canonical}: ${err?.message ?? err}`, { cause: err })
	}
	return canonical
}

function productHome() {
	return readProductEnv(process.env, "HOME") || defaultProductHome()
}

export function isTestProcess() {
	if (readProductEnv(process.env, "TEST") === "1") return true
	if (process.env.NODE_TEST_CONTEXT) return true
	return process.argv.some((arg) => arg === "--test" || /\.test\.[cm]?[jt]s$/.test(arg))
}

function assertSafeTestHome() {
	if (!isTestProcess() || readProductEnv(process.env, "ALLOW_PRODUCTION_HOME_IN_TESTS") === "1") return
	const home = readProductEnv(process.env, "HOME")
	const persistentHomes = [PRODUCT_STATE_DIRECTORY, LEGACY_PRODUCT_STATE_DIRECTORY].map((name) => resolve(homedir(), name))
	if (!home) {
		throw new Error("Cerex tests require an isolated CEREX_HOME. Set CEREX_HOME to a temp directory.")
	}
	const resolved = resolve(home)
	if (persistentHomes.some((persistentHome) => resolved === persistentHome || resolved.startsWith(`${persistentHome}/`))) {
		throw new Error(`Cerex tests refuse to use persistent CEREX_HOME (${home}). Set CEREX_HOME to a temp directory.`)
	}
}

function isUnsafeTestHomeError(err) {
	return isTestProcess() && /Cerex tests refuse to use persistent CEREX_HOME|Cerex tests require an isolated CEREX_HOME/.test(err?.message ?? String(err))
}

/** @returns {string} */
export function productHomePath() {
	assertSafeTestHome()
	return productHome()
}

/** @returns {string | undefined} */
export function optionalProductHomePath() {
	if (isTestProcess() && !readProductEnv(process.env, "HOME")) return undefined
	try {
		return productHomePath()
	} catch (err) {
		if (isUnsafeTestHomeError(err)) return undefined
		throw err
	}
}

/** @returns {string} */
export function dataRoot() {
	assertSafeTestHome()
	return join(productHome(), "data")
}

function configuredServiceRoot() {
	return readProductEnv(process.env, "SERVICE_DIR")
}

/** @returns {string} */
export function serviceStateRoot() {
	const configured = configuredServiceRoot()
	if (configured) return configured
	assertSafeTestHome()
	return join(productHome(), "data", "services")
}

/** @returns {string} */
export function serviceStateDir() {
	return join(serviceStateRoot(), "global")
}

/** @returns {string} */
export function runtimeSourceReferenceRoot() {
	return join(dataRoot(), "services", "global", "runtime-source")
}

/** @returns {string} */
export function runtimeSourceReferencePath() {
	return join(runtimeSourceReferenceRoot(), "current")
}

/**
 * Launchers and context rendering can run in unit tests that intentionally do
 * not use a product state directory. In that case there is no service-created
 * source reference to mount or describe.
 * @returns {string | undefined}
 */
export function optionalRuntimeSourceReferencePath() {
	if (isTestProcess() && !readProductEnv(process.env, "HOME")) return undefined
	let path
	try {
		path = runtimeSourceReferencePath()
	} catch (err) {
		if (isUnsafeTestHomeError(err)) return undefined
		throw err
	}
	try {
		return statSync(path).isDirectory() ? path : undefined
	} catch (err) {
		if (err?.code === "ENOENT") return undefined
		throw err
	}
}

/** @returns {string} */
export function environmentsRoot() {
	assertSafeTestHome()
	return join(productHome(), "environments")
}

/** @returns {string} */
export function sessionWorkspacesRoot() {
	assertSafeTestHome()
	return join(productHome(), "sessions")
}

/** @returns {string | undefined} */
export function optionalSessionWorkspacesRoot() {
	const home = optionalProductHomePath()
	return home ? join(home, "sessions") : undefined
}

/**
 * Service-owned directory for durable files associated with one session.
 * @param {string} sessionId
 * @returns {string}
 */
export function sessionWorkspacePath(sessionId) {
	return join(sessionWorkspacesRoot(), sessionWorkspaceDirName(sessionId))
}

/**
 * Per-session workspace path when a safe Cerex home is available.
 * @param {string | undefined} sessionId
 * @returns {string | undefined}
 */
export function optionalSessionWorkspacePath(sessionId) {
	if (!sessionId) return undefined
	const root = optionalSessionWorkspacesRoot()
	return root ? join(root, sessionWorkspaceDirName(sessionId)) : undefined
}

/**
 * Writable native-sandbox home for tools belonging to one configured environment.
 * @param {string | undefined} environmentId
 * @returns {string}
 */
export function environmentHomePath(environmentId) {
	return join(environmentsRoot(), safePathComponent(environmentId), "home")
}

export const managedContainerHomePath = "/home/cerex"

/**
 * Host-side home directory for Cerex-managed container environments.
 * @param {string | undefined} environmentId
 * @returns {string}
 */
export function environmentContainerHomePath(environmentId) {
	return join(environmentsRoot(), safePathComponent(environmentId), "container-home")
}

/** @returns {string} */
export function settingsPath() {
	return join(productHomePath(), "settings.json")
}

/** @returns {string} */
export function defaultSettingsPath() {
	return join(productHomePath(), "default-settings.json")
}

/** @returns {string} */
export function environmentsConfigPath() {
	return join(productHomePath(), "environments.json")
}

/** @returns {string} */
export function authDir() {
	return join(productHomePath(), "auth")
}

/**
 * @param {string} provider
 * @returns {string}
 */
export function authFilePath(provider) {
	return join(authDir(), `${provider}.json`)
}

/**
 * SQLite database used by Cerex server/web mode and the TUI/RPC session store.
 * It is the canonical store for session metadata, transcript entries, run state,
 * and service lifecycle records.
 * @returns {string}
 */
export function serverDbPath() {
	return join(dataRoot(), "server.sqlite")
}

/**
 * Content-free, periodically aggregated model API performance metrics.
 * @returns {string}
 */
export function metricsDbPath() {
	return join(dataRoot(), "metrics.sqlite")
}

/** @returns {string} */
export function updateCheckStatePath() {
	return join(dataRoot(), "update-check.json")
}
