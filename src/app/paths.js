// Centralized path resolution for pinano on-disk state.
//
// Defaults to ~/.pinano. Override the entire user, data, and environment root
// with $PINANO_HOME — useful for tests and custom installs.

import { statSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { migrateLegacyConfigDirSync } from "./home-migration.js"
import { safePathComponent, sessionWorkspaceDirName } from "./session-workspace-names.js"

const migratedHomes = new Set()

function pinanoHome() {
	return process.env.PINANO_HOME || join(homedir(), ".pinano")
}

export function isPinanoTestProcess() {
	if (process.env.PINANO_TEST === "1") return true
	if (process.env.NODE_TEST_CONTEXT) return true
	return process.argv.some((arg) => arg === "--test" || /\.test\.[cm]?[jt]s$/.test(arg))
}

function assertSafeTestHome() {
	if (!isPinanoTestProcess() || process.env.PINANO_ALLOW_PRODUCTION_HOME_IN_TESTS === "1") return
	const home = process.env.PINANO_HOME
	const persistentAgentHome = resolve(homedir(), ".pinano")
	if (!home) {
		throw new Error("Pinano tests require an isolated PINANO_HOME. Set PINANO_HOME to a temp directory.")
	}
	const resolved = resolve(home)
	if (resolved === persistentAgentHome || resolved.startsWith(`${persistentAgentHome}/`)) {
		throw new Error(`Pinano tests refuse to use persistent PINANO_HOME (${home}). Set PINANO_HOME to a temp directory.`)
	}
}

function isUnsafeTestHomeError(err) {
	return isPinanoTestProcess() && /Pinano tests refuse to use persistent PINANO_HOME|Pinano tests require an isolated PINANO_HOME/.test(err?.message ?? String(err))
}

function ensureHomeMigrated() {
	const home = pinanoHome()
	if (migratedHomes.has(home)) return
	migrateLegacyConfigDirSync(home)
	migratedHomes.add(home)
}

/** @returns {string} */
export function pinanoHomePath() {
	assertSafeTestHome()
	ensureHomeMigrated()
	return pinanoHome()
}

/** @returns {string | undefined} */
export function optionalPinanoHomePath() {
	if (isPinanoTestProcess() && !process.env.PINANO_HOME) return undefined
	try {
		return pinanoHomePath()
	} catch (err) {
		if (isUnsafeTestHomeError(err)) return undefined
		throw err
	}
}

/** @returns {string} */
export function dataRoot() {
	assertSafeTestHome()
	ensureHomeMigrated()
	return join(pinanoHome(), "data")
}

function configuredServiceRoot() {
	return process.env.PINANO_SERVICE_DIR || process.env.PINANO_DAEMON_DIR
}

/** @returns {string} */
export function serviceStateRoot() {
	const configured = configuredServiceRoot()
	if (configured) return configured
	assertSafeTestHome()
	ensureHomeMigrated()
	return join(pinanoHome(), "data", "services")
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
 * not use a Pinano state directory. In that case there is no service-created
 * source reference to mount or describe.
 * @returns {string | undefined}
 */
export function optionalRuntimeSourceReferencePath() {
	if (isPinanoTestProcess() && !process.env.PINANO_HOME) return undefined
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
	ensureHomeMigrated()
	return join(pinanoHome(), "environments")
}

/** @returns {string} */
export function sessionWorkspacesRoot() {
	assertSafeTestHome()
	ensureHomeMigrated()
	return join(pinanoHome(), "sessions")
}

/** @returns {string | undefined} */
export function optionalSessionWorkspacesRoot() {
	const home = optionalPinanoHomePath()
	return home ? join(home, "sessions") : undefined
}

/**
 * Per-session workspace for scratch files and tool temp state.
 * @param {string} sessionId
 * @returns {string}
 */
export function sessionWorkspacePath(sessionId) {
	return join(sessionWorkspacesRoot(), sessionWorkspaceDirName(sessionId))
}

/**
 * Per-session workspace path when a safe Pinano home is available.
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

/** @returns {string} */
export function settingsPath() {
	return join(pinanoHomePath(), "settings.json")
}

/** @returns {string} */
export function defaultSettingsPath() {
	return join(pinanoHomePath(), "default-settings.json")
}

/** @returns {string} */
export function environmentsConfigPath() {
	return join(pinanoHomePath(), "environments.json")
}

/** @returns {string} */
export function authDir() {
	return join(pinanoHomePath(), "auth")
}

/**
 * @param {string} provider
 * @returns {string}
 */
export function authFilePath(provider) {
	return join(authDir(), `${provider}.json`)
}

/**
 * SQLite database used by Pinano server/web mode and the TUI/RPC session store.
 * It is the canonical store for session metadata, transcript entries, run state,
 * and service lifecycle records.
 * @returns {string}
 */
export function serverDbPath() {
	return join(dataRoot(), "server.sqlite")
}

/** @returns {string} */
export function updateCheckStatePath() {
	return join(dataRoot(), "update-check.json")
}
