// Centralized path resolution for pinano on-disk state.
//
// Defaults to XDG ($XDG_CONFIG_HOME, $XDG_DATA_HOME), falls back to ~/.config
// and ~/.local/share. Override the entire config/data root with $PINANO_HOME
// — useful for tests.

import { homedir } from "node:os"
import { join } from "node:path"

export function configRoot(): string {
	if (process.env.PINANO_HOME) return join(process.env.PINANO_HOME, "config")
	const xdg = process.env.XDG_CONFIG_HOME
	return join(xdg ?? join(homedir(), ".config"), "pinano")
}

export function dataRoot(): string {
	if (process.env.PINANO_HOME) return join(process.env.PINANO_HOME, "data")
	const xdg = process.env.XDG_DATA_HOME
	return join(xdg ?? join(homedir(), ".local/share"), "pinano")
}

export function settingsPath(): string {
	return join(configRoot(), "settings.json")
}

export function authDir(): string {
	return join(configRoot(), "auth")
}

export function authFilePath(provider: string): string {
	return join(authDir(), `${provider}.json`)
}

/** Sessions live under data/, one file per session. */
export function sessionsDir(): string {
	return join(dataRoot(), "sessions")
}

/** Index of cwd → most-recent-session-id. */
export function sessionIndexPath(): string {
	return join(dataRoot(), "session-index.json")
}
