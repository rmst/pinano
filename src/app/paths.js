// Centralized path resolution for pinano on-disk state.
//
// Defaults to ~/.pinano. Override the entire config/data/environment root with
// $PINANO_HOME — useful for tests and custom installs.

import { homedir } from "node:os"
import { join, resolve } from "node:path"

function pinanoHome() {
	return process.env.PINANO_HOME || join(homedir(), ".pinano")
}

function safePathComponent(value) {
	return String(value || "local").replace(/[^A-Za-z0-9_-]/g, "_")
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

/** @returns {string} */
export function configRoot() {
	assertSafeTestHome()
	return join(pinanoHome(), "config")
}

/** @returns {string} */
export function dataRoot() {
	assertSafeTestHome()
	return join(pinanoHome(), "data")
}

/** @returns {string} */
export function environmentsRoot() {
	assertSafeTestHome()
	return join(pinanoHome(), "environments")
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
	return join(configRoot(), "settings.json")
}

/** @returns {string} */
export function defaultSettingsPath() {
	return join(configRoot(), "default-settings.json")
}

/** @returns {string} */
/** @returns {string} */
export function environmentsConfigPath() {
	return join(configRoot(), "environments.json")
}

/** @returns {string} */
export function authDir() {
	return join(configRoot(), "auth")
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
