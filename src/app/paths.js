// Centralized path resolution for pinano on-disk state.
//
// Defaults to XDG ($XDG_CONFIG_HOME, $XDG_DATA_HOME), falls back to ~/.config
// and ~/.local/share. Override the entire config/data root with $PINANO_HOME
// — useful for tests.

import { homedir } from "node:os"
import { join } from "node:path"

/** @returns {string} */
export function configRoot() {
	if (process.env.PINANO_HOME) return join(process.env.PINANO_HOME, "config")
	const xdg = process.env.XDG_CONFIG_HOME
	return join(xdg ?? join(homedir(), ".config"), "pinano")
}

/** @returns {string} */
export function dataRoot() {
	if (process.env.PINANO_HOME) return join(process.env.PINANO_HOME, "data")
	const xdg = process.env.XDG_DATA_HOME
	return join(xdg ?? join(homedir(), ".local/share"), "pinano")
}

/** @returns {string} */
export function settingsPath() {
	return join(configRoot(), "settings.json")
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
 * Sessions live under data/, one file per session.
 * @returns {string}
 */
export function sessionsDir() {
	return join(dataRoot(), "sessions")
}

/**
 * Index of cwd → most-recent-session-id.
 * @returns {string}
 */
export function sessionIndexPath() {
	return join(dataRoot(), "session-index.json")
}
